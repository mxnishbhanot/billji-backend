import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Invoice from '../src/models/Invoice.js';
import Payment from '../src/models/Payment.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { claimCreditFromNote, claimCreditFromPayment } from '../src/modules/payments/repository.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

let seq = 0;
const idempotent = (scope) => {
  seq += 1;
  return { [IDEMPOTENCY_HEADER]: `${scope}-${seq}-${Math.random().toString(36).slice(2, 8)}` };
};

// ₹1000 invoice: 2 x ₹500, no tax, no discount.
const setup = async () => {
  const context = await createTestContext();
  const customer = await createCustomer(context.business);
  const product = await createProduct(context.business, { stockQuantity: 100, price: 500, taxRate: 0 });

  const res = await api()
    .post('/api/v1/invoices')
    .set(authHeader(context.token))
    .set(idempotent('invoice'))
    .send({
      customerId: customer._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 2, price: 500 }],
      taxRate: 0,
      discountType: 'flat',
      discountValue: 0,
      allowOversell: true
    })
    .expect(201);

  return { ...context, customer, product, invoice: res.body.invoice };
};

const creditNoteRequest = (token, customer, product, invoiceId, quantity) =>
  api()
    .post('/api/v1/documents/credit_note')
    .set(authHeader(token))
    .set(idempotent('credit_note'))
    .send({
      customerId: customer._id.toString(),
      items: [{ productId: product._id.toString(), quantity, price: 500, taxRate: 0 }],
      sourceInvoiceId: invoiceId
    });

describe('credit note over-crediting under concurrency', () => {
  it('lets exactly one of two overlapping credit notes take the invoice', async () => {
    const { token, customer, product, invoice } = await setup();

    // Each note is for ₹1000 of a ₹1000 invoice: together they would credit double.
    const results = await Promise.all([
      creditNoteRequest(token, customer, product, invoice._id, 2),
      creditNoteRequest(token, customer, product, invoice._id, 2)
    ]);

    const statuses = results.map((res) => res.status).sort();
    assert.deepEqual(statuses, [201, 409]);

    const rejected = results.find((res) => res.status === 409);
    assert.equal(rejected.body.details?.code || rejected.body.code, 'CREDIT_NOTE_EXCEEDS_INVOICE');

    assert.equal(await Invoice.countDocuments({ documentType: 'credit_note', sourceInvoice: invoice._id }), 1);
    assert.equal((await Invoice.findById(invoice._id).lean()).creditedAmount, 1000);
  });

  it('counts partial notes against the same ceiling', async () => {
    const { token, customer, product, invoice } = await setup();

    // Three halves do not fit in one invoice.
    const results = await Promise.all([
      creditNoteRequest(token, customer, product, invoice._id, 1),
      creditNoteRequest(token, customer, product, invoice._id, 1),
      creditNoteRequest(token, customer, product, invoice._id, 1)
    ]);

    assert.equal(results.filter((res) => res.status === 201).length, 2);
    assert.equal(results.filter((res) => res.status === 409).length, 1);
    assert.equal((await Invoice.findById(invoice._id).lean()).creditedAmount, 1000);
  });

  it('returns the room when a credit note is cancelled, so the invoice can be credited again', async () => {
    const { token, customer, product, invoice } = await setup();

    const first = await creditNoteRequest(token, customer, product, invoice._id, 2).expect(201);
    assert.equal((await Invoice.findById(invoice._id).lean()).creditedAmount, 1000);

    await api()
      .post(`/api/v1/documents/credit_note/${first.body.document._id}/cancel`)
      .set(authHeader(token))
      .send({})
      .expect(200);

    assert.equal((await Invoice.findById(invoice._id).lean()).creditedAmount, 0);

    // The value is creditable once more, which it would not be if the counter only ever rose.
    await creditNoteRequest(token, customer, product, invoice._id, 2).expect(201);
    assert.equal((await Invoice.findById(invoice._id).lean()).creditedAmount, 1000);
  });
});

// These call the guards directly, with no session at all — the dev fallback's execution
// mode. They prove the safety property comes from single-document atomicity and not from
// replica-set transactions.
describe('credit consumption guards without a transaction', () => {
  it('lets exactly one of two concurrent claims take the rest of a credit note', async () => {
    const { business, token, customer, product, invoice } = await setup();
    const created = await creditNoteRequest(token, customer, product, invoice._id, 2).expect(201);
    const note = await Invoice.findById(created.body.document._id).lean();

    const claims = await Promise.all([
      claimCreditFromNote(business._id, note, 1000),
      claimCreditFromNote(business._id, note, 1000)
    ]);

    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await Invoice.findById(note._id).lean()).appliedAmount, 1000);
  });

  it('refuses a claim that would take more than the note has left', async () => {
    const { business, token, customer, product, invoice } = await setup();
    const created = await creditNoteRequest(token, customer, product, invoice._id, 2).expect(201);
    const note = await Invoice.findById(created.body.document._id).lean();

    assert.ok(await claimCreditFromNote(business._id, note, 700));
    assert.equal(await claimCreditFromNote(business._id, note, 400), null);
    assert.ok(await claimCreditFromNote(business._id, note, 300));
    assert.equal((await Invoice.findById(note._id).lean()).appliedAmount, 1000);
  });

  it('lets exactly one of two concurrent claims take an overpayment', async () => {
    const { business, token, customer, invoice } = await setup();

    // ₹1400 against a ₹1000 invoice parks ₹400 of unapplied credit.
    await api()
      .post(`/api/v1/payments/invoices/${invoice._id}/record`)
      .set(authHeader(token))
      .set(idempotent('pay'))
      .send({ amount: 1400, method: 'cash' })
      .expect(201);

    const payment = await Payment.findOne({ customer: customer._id }).lean();
    assert.equal(payment.unappliedAmount, 400);

    const claims = await Promise.all([
      claimCreditFromPayment(business._id, payment._id, 400),
      claimCreditFromPayment(business._id, payment._id, 400)
    ]);

    assert.equal(claims.filter(Boolean).length, 1);

    const after = await Payment.findById(payment._id).lean();
    assert.equal(after.unappliedAmount, 0);
    assert.equal(after.allocatedAmount, 1400);
  });
});
