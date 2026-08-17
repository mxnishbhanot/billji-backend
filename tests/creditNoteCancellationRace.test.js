import mongoose from 'mongoose';
import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Customer from '../src/models/Customer.js';
import Invoice from '../src/models/Invoice.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import SettlementAllocation from '../src/models/SettlementAllocation.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { claimCreditFromNote, closeCreditNoteForCancellation } from '../src/modules/payments/repository.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

// F-1: credit-note cancellation vs a concurrent credit application, both racing to consume
// the same note. cancelDocumentWorkflow used to read appliedAmount, then save 'cancelled' —
// a plain document.save() that established nothing atomically. These tests exercise the
// fixed closeCreditNoteForCancellation gate directly (no session, the dev fallback's actual
// execution mode — the same way creditConcurrency.test.js exercises claimCreditFromNote).

useMongoTestDb();

const api = () => request(app);

let seq = 0;
const idempotent = (scope) => {
  seq += 1;
  return { [IDEMPOTENCY_HEADER]: `${scope}-${seq}-${Math.random().toString(36).slice(2, 8)}` };
};

const setup = async () => {
  const context = await createTestContext();
  const customer = await createCustomer(context.business);
  const product = await createProduct(context.business, { stockQuantity: 1000, price: 500, taxRate: 0 });
  return { ...context, customer, product };
};

const createInvoice = async (token, customer, product, quantity) => {
  const res = await api()
    .post('/api/v1/invoices')
    .set(authHeader(token))
    .set(idempotent('invoice'))
    .send({
      customerId: customer._id.toString(),
      items: [{ productId: product._id.toString(), quantity, price: 500, taxRate: 0 }],
      taxRate: 0,
      discountType: 'flat',
      discountValue: 0,
      allowOversell: true
    })
    .expect(201);
  return res.body.invoice;
};

const createCreditNote = async (token, customer, product, sourceInvoiceId, quantity) => {
  const res = await api()
    .post('/api/v1/documents/credit_note')
    .set(authHeader(token))
    .set(idempotent('credit_note'))
    .send({
      customerId: customer._id.toString(),
      items: [{ productId: product._id.toString(), quantity, price: 500, taxRate: 0 }],
      sourceInvoiceId
    })
    .expect(201);
  return res.body.document;
};

const applyCredit = (token, invoiceId, amount) =>
  api()
    .post(`/api/v1/payments/invoices/${invoiceId}/apply-credit`)
    .set(authHeader(token))
    .set(idempotent('apply'))
    .send({ amount });

const cancelNote = (token, noteId) =>
  api().post(`/api/v1/documents/credit_note/${noteId}/cancel`).set(authHeader(token)).send({});

const docOf = (id) => Invoice.findById(id).lean();
const creditOf = async (customerId) => (await Customer.findById(customerId).lean()).availableCredit;
const asObjectId = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

const assertLedgerBalanced = async (business) => {
  const rows = await LedgerEntry.find({ business: business._id }).lean();
  const debits = rows.filter((row) => row.direction === 'debit').reduce((sum, row) => sum + row.amount, 0);
  const credits = rows.filter((row) => row.direction === 'credit').reduce((sum, row) => sum + row.amount, 0);
  assert.equal(Math.round(debits * 100), Math.round(credits * 100));
};

describe('F-1: credit-note cancellation vs credit application race', () => {
  it('cancellation first: the atomic close wins, the later application is rejected outright', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 4); // 2000
    const note = await createCreditNote(token, customer, product, invoice._id, 4); // 2000

    // Atomically close the note for cancellation with no session — the fallback path.
    const closed = await closeCreditNoteForCancellation(business._id, note._id, {
      documentStatus: 'cancelled',
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: null,
      shareRevokedAt: new Date()
    });
    assert.ok(closed);
    assert.equal(closed.documentStatus, 'cancelled');

    // The application must now fail: claimCreditFromNote requires documentStatus: 'issued'.
    const claim = await claimCreditFromNote(business._id, { _id: note._id, total: note.total }, 1000);
    assert.equal(claim, null);

    assert.equal(await SettlementAllocation.countDocuments({ business: business._id, creditNote: note._id }), 0);
    assert.equal((await docOf(note._id)).appliedAmount, 0);
    assert.equal((await docOf(invoice._id)).settledAmount || 0, 0);
  });

  it('application first: the claim wins, the later atomic close is refused', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 4); // 2000
    const note = await createCreditNote(token, customer, product, invoice._id, 4); // 2000

    const claim = await claimCreditFromNote(business._id, { _id: note._id, total: note.total }, 1000);
    assert.ok(claim);
    assert.equal(claim.appliedAmount, 1000);

    // The close's own predicate (appliedAmount: 0) now fails — it never flips documentStatus.
    const closed = await closeCreditNoteForCancellation(business._id, note._id, {
      documentStatus: 'cancelled',
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: null,
      shareRevokedAt: new Date()
    });
    assert.equal(closed, null);
    assert.equal((await docOf(note._id)).documentStatus, 'issued');
  });

  it('end to end: cancelling a note with a live application is rejected and changes nothing', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 4); // 2000
    const note = await createCreditNote(token, customer, product, invoice._id, 4); // 2000

    const applied = await applyCredit(token, invoice._id, 1000).expect(201);
    const allocationId = applied.body.allocations[0]._id;

    const res = await cancelNote(token, note._id).expect(409);
    assert.equal(res.body.details?.code || res.body.code, 'CREDIT_NOTE_HAS_APPLICATIONS');

    assert.equal((await docOf(note._id)).documentStatus, 'issued');
    assert.equal((await docOf(note._id)).appliedAmount, 1000);
    const allocation = await SettlementAllocation.findById(allocationId).lean();
    assert.equal(allocation.reversedAt, null);
    assert.equal((await docOf(invoice._id)).balanceDue, 1000);
    await assertLedgerBalanced(business);
  });

  it('cancellation is idempotent once it succeeds', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 4);
    const note = await createCreditNote(token, customer, product, invoice._id, 4);

    await cancelNote(token, note._id).expect(200);
    const repeat = await cancelNote(token, note._id).expect(200);
    assert.equal(repeat.body.document.documentStatus, 'cancelled');
    assert.equal((await docOf(note._id)).documentStatus, 'cancelled');
  });

  it('reconciles the ledger through issue, apply, and reversed-then-cancelled', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 4); // 2000
    const note = await createCreditNote(token, customer, product, invoice._id, 4); // 2000

    const applied = await applyCredit(token, invoice._id, 1000).expect(201);
    await api()
      .post(`/api/v1/payments/allocations/${applied.body.allocations[0]._id}/reverse`)
      .set(authHeader(token))
      .set(idempotent('reverse'))
      .send({})
      .expect(200);

    await cancelNote(token, note._id).expect(200);

    await assertLedgerBalanced(business);
    assert.equal(await creditOf(customer._id), 0);
    assert.equal((await docOf(invoice._id)).balanceDue, 2000);
  });
});
