import mongoose from 'mongoose';
import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Customer from '../src/models/Customer.js';
import Invoice from '../src/models/Invoice.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import Payment from '../src/models/Payment.js';
import Product from '../src/models/Product.js';
import SettlementAllocation from '../src/models/SettlementAllocation.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

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

const reverseApplication = (token, allocationId) =>
  api()
    .post(`/api/v1/payments/allocations/${allocationId}/reverse`)
    .set(authHeader(token))
    .set(idempotent('reverse'))
    .send({});

const cancelNote = (token, noteId) =>
  api().post(`/api/v1/documents/credit_note/${noteId}/cancel`).set(authHeader(token)).send({});

const cancelInvoice = (token, invoiceId) =>
  api().patch(`/api/v1/invoices/${invoiceId}/status`).set(authHeader(token)).send({ status: 'cancelled' });

const docOf = (id) => Invoice.findById(id).lean();
const creditOf = async (customerId) => (await Customer.findById(customerId).lean()).availableCredit;
const codeOf = (res) => res.body.details?.code || res.body.code;
const asObjectId = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

describe('cancelling a credit note that has been applied', () => {
  it('is blocked while any of its credit is in use', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10); // 5000
    const note = await createCreditNote(token, customer, product, invoice._id, 4); // 2000

    await applyCredit(token, invoice._id, 800).expect(201);

    const res = await cancelNote(token, note._id).expect(409);
    assert.equal(codeOf(res), 'CREDIT_NOTE_HAS_APPLICATIONS');
    assert.equal(res.body.details.total, 2000);
    assert.equal(res.body.details.appliedAmount, 800);
    assert.equal(res.body.details.remaining, 1200);
    assert.deepEqual(res.body.details.applications, [{ invoiceNumber: invoice.invoiceNumber, amount: 800 }]);

    // Nothing mutated: the note still stands and stock stayed where it was.
    const afterNote = await docOf(note._id);
    assert.equal(afterNote.documentStatus, 'issued');
    assert.equal(afterNote.appliedAmount, 800);
    assert.equal((await Product.findById(product._id).lean()).stockQuantity, 994);
  });

  it('succeeds once the application is reversed', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10);
    const note = await createCreditNote(token, customer, product, invoice._id, 4); // 2000

    const applied = await applyCredit(token, invoice._id, 800).expect(201);
    await reverseApplication(token, applied.body.allocations[0]._id).expect(200);
    await cancelNote(token, note._id).expect(200);

    const afterNote = await docOf(note._id);
    assert.equal(afterNote.documentStatus, 'cancelled');
    assert.equal(afterNote.appliedAmount, 0);
    // The note's goods go back out again on cancellation.
    assert.equal((await Product.findById(product._id).lean()).stockQuantity, 990);
    assert.equal(await creditOf(customer._id), 0);

    // Issue entries compensated, and the invoice owes the full amount once more.
    const issued = await LedgerEntry.find({ business: business._id, salesDocument: asObjectId(note._id), sourceType: 'credit_note' }).lean();
    const reversals = await LedgerEntry.find({ business: business._id, salesDocument: asObjectId(note._id), sourceType: 'adjustment' }).lean();
    assert.equal(issued.length, 2);
    assert.equal(reversals.length, 2);
    assert.equal((await docOf(invoice._id)).balanceDue, 5000);
  });
});

describe('cancelling an invoice with credit notes against it', () => {
  it('is blocked while a live note references it', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10);
    await createCreditNote(token, customer, product, invoice._id, 2);

    const res = await cancelInvoice(token, invoice._id).expect(409);
    assert.equal(codeOf(res), 'INVOICE_HAS_CREDIT_NOTES');
    assert.equal(res.body.details.creditNoteCount, 1);
    assert.equal((await docOf(invoice._id)).documentStatus, 'issued');
  });

  it('succeeds once the notes are cancelled', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10);
    const note = await createCreditNote(token, customer, product, invoice._id, 2);

    await cancelNote(token, note._id).expect(200);
    await cancelInvoice(token, invoice._id).expect(200);

    assert.equal((await docOf(invoice._id)).documentStatus, 'cancelled');
  });

  it('tells the client the invoice cannot be cancelled or deleted yet', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10);
    const note = await createCreditNote(token, customer, product, invoice._id, 2);

    const blocked = await api().get(`/api/v1/invoices/${invoice._id}`).set(authHeader(token)).expect(200);
    // The flags must agree with what the workflows actually allow, or the UI offers an
    // action the server refuses.
    assert.equal(blocked.body.invoice.eligibility.hasCreditNotes, true);
    assert.equal(blocked.body.invoice.eligibility.canCancel, false);
    assert.equal(blocked.body.invoice.eligibility.canDelete, false);

    await cancelNote(token, note._id).expect(200);

    const freed = await api().get(`/api/v1/invoices/${invoice._id}`).set(authHeader(token)).expect(200);
    assert.equal(freed.body.invoice.eligibility.hasCreditNotes, false);
    assert.equal(freed.body.invoice.eligibility.canCancel, true);
  });
});

describe('cancelling an invoice that had credit applied to it', () => {
  it('returns the credit to the pool instead of losing it', async () => {
    const { business, token, customer, product } = await setup();
    const source = await createInvoice(token, customer, product, 20); // 10000
    const target = await createInvoice(token, customer, product, 4); // 2000
    const note = await createCreditNote(token, customer, product, source._id, 3); // 1500

    const applied = await applyCredit(token, target._id, 1500).expect(201);
    const allocationId = applied.body.allocations[0]._id;
    assert.equal(await creditOf(customer._id), 0);

    await cancelInvoice(token, target._id).expect(200);

    const allocation = await SettlementAllocation.findById(allocationId).lean();
    assert.notEqual(allocation.reversedAt, null);
    assert.equal((await docOf(note._id)).appliedAmount, 0);
    // The credit is spendable again, which is the whole point of the rule.
    assert.equal(await creditOf(customer._id), 1500);

    const reversals = await LedgerEntry.find({ business: business._id, sourceType: 'adjustment' }).lean();
    const applicationReversals = reversals.filter((entry) => entry.description.includes('credit application reversed'));
    assert.deepEqual(
      applicationReversals.map((entry) => `${entry.account}:${entry.direction}`).sort(),
      ['accounts_receivable:debit', 'customer_credits:credit']
    );
  });

  it('returns applied overpayment cash to the payment it came from', async () => {
    const { token, customer, product } = await setup();
    const paid = await createInvoice(token, customer, product, 1); // 500
    const target = await createInvoice(token, customer, product, 4); // 2000

    await api()
      .post(`/api/v1/payments/invoices/${paid._id}/record`)
      .set(authHeader(token))
      .set(idempotent('pay'))
      .send({ amount: 900, method: 'cash' })
      .expect(201);
    const payment = await Payment.findOne({ invoice: paid._id }).lean();
    assert.equal(payment.unappliedAmount, 400);

    await applyCredit(token, target._id, 400).expect(201);
    await cancelInvoice(token, target._id).expect(200);

    // Money never left the business, so it goes back to unapplied rather than being
    // stranded against a cancelled invoice.
    const afterPayment = await Payment.findById(payment._id).lean();
    assert.equal(afterPayment.unappliedAmount, 400);
    assert.equal(afterPayment.allocatedAmount, 500);
    assert.equal(await creditOf(customer._id), 400);
  });

  it('leaves cash allocations alone and flags them for refund', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 4); // 2000

    await api()
      .post(`/api/v1/payments/invoices/${invoice._id}/record`)
      .set(authHeader(token))
      .set(idempotent('pay'))
      .send({ amount: 2000, method: 'cash' })
      .expect(201);

    await cancelInvoice(token, invoice._id).expect(200);

    // Cash cannot be un-received: the allocation stands and the receipt is refund-pending.
    const allocation = await SettlementAllocation.findOne({ business: business._id, invoice: asObjectId(invoice._id) }).lean();
    assert.equal(allocation.reversedAt, null);
    assert.equal((await Payment.findOne({ invoice: asObjectId(invoice._id) }).lean()).refundStatus, 'pending');
  });

  it('reverses a fully-credited invoice back to unpaid', async () => {
    const { token, customer, product } = await setup();
    const source = await createInvoice(token, customer, product, 20);
    const target = await createInvoice(token, customer, product, 2); // 1000
    await createCreditNote(token, customer, product, source._id, 2); // 1000

    const applied = await applyCredit(token, target._id, 1000).expect(201);
    assert.equal((await docOf(target._id)).paymentStatus, 'paid');

    await reverseApplication(token, applied.body.allocations[0]._id).expect(200);

    const after = await docOf(target._id);
    assert.equal(after.paymentStatus, 'unpaid');
    assert.equal(after.balanceDue, 1000);
    assert.equal(after.creditApplied, 0);
  });
});

describe('a credit note without a customer', () => {
  it('holds credit nobody can spend and touches no balance', async () => {
    const { business, token, product } = await setup();
    const walkIn = await api()
      .post('/api/v1/invoices')
      .set(authHeader(token))
      .set(idempotent('invoice'))
      .send({
        customer: { name: 'Walk-in', phone: '9000000001' },
        items: [{ productId: product._id.toString(), quantity: 4, price: 500, taxRate: 0 }],
        taxRate: 0,
        allowOversell: true
      })
      .expect(201);

    await api()
      .post('/api/v1/documents/credit_note')
      .set(authHeader(token))
      .set(idempotent('credit_note'))
      .send({
        customer: { name: 'Walk-in', phone: '9000000001' },
        items: [{ productId: product._id.toString(), quantity: 2, price: 500, taxRate: 0 }],
        sourceInvoiceId: walkIn.body.invoice._id
      })
      .expect(201);

    // No customer record was created or credited by either document.
    assert.equal(await Customer.countDocuments({ business: business._id, name: 'Walk-in' }), 0);

    // There is no customer to hold the credit, so none can be applied.
    const res = await applyCredit(token, walkIn.body.invoice._id, 500).expect(422);
    assert.match(res.body.message, /saved customer/);
  });
});
