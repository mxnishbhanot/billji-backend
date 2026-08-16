import mongoose from 'mongoose';
import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Customer from '../src/models/Customer.js';
import Invoice from '../src/models/Invoice.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import Payment from '../src/models/Payment.js';
import SettlementAllocation from '../src/models/SettlementAllocation.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { getReportSummary, invalidateReportSummaryCache } from '../src/services/reportService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

let seq = 0;
const idempotent = (scope) => {
  seq += 1;
  return { [IDEMPOTENCY_HEADER]: `${scope}-${seq}-${Math.random().toString(36).slice(2, 8)}` };
};

// Everything is priced at 500/unit with no tax, so an amount reads directly as a quantity.
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

const applyCredit = (token, invoiceId, amount, headers = idempotent('apply')) =>
  api()
    .post(`/api/v1/payments/invoices/${invoiceId}/apply-credit`)
    .set(authHeader(token))
    .set(headers)
    .send({ amount });

const reverseApplication = (token, allocationId, body = {}) =>
  api()
    .post(`/api/v1/payments/allocations/${allocationId}/reverse`)
    .set(authHeader(token))
    .set(idempotent('reverse'))
    .send(body);

// FIFO orders by (sourceDate, _id), so tests that care about order stamp the dates
// explicitly rather than relying on creation happening in different milliseconds.
const stampDate = (model, id, date) => model.updateOne({ _id: id }, { $set: model === Payment ? { receivedAt: date } : { date } });

// Mixed-type metadata is stored as an ObjectId; a hex string from the JSON response will
// not match it, so tests cast before querying.
const asObjectId = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

const noteOf = (id) => Invoice.findById(id).lean();
const creditOf = async (customerId) => (await Customer.findById(customerId).lean()).availableCredit;
const duesOf = async (customerId) => (await Customer.findById(customerId).lean()).outstandingDues;

describe('applying customer credit to an invoice', () => {
  it('applies part of a credit note and leaves the rest available', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10); // 5000
    const note = await createCreditNote(token, customer, product, invoice._id, 4); // 2000

    const res = await applyCredit(token, invoice._id, 700).expect(201);

    assert.equal(res.body.appliedAmount, 700);
    assert.equal(res.body.allocations.length, 1);
    assert.equal(res.body.allocations[0].source, 'credit_note');
    assert.equal(String(res.body.allocations[0].creditNote), String(note._id));

    const afterNote = await noteOf(note._id);
    assert.equal(afterNote.total, 2000);
    assert.equal(afterNote.appliedAmount, 700);

    const afterInvoice = await noteOf(invoice._id);
    // Credit settles the invoice without claiming money arrived.
    assert.equal(afterInvoice.paidAmount, 0);
    assert.equal(afterInvoice.creditApplied, 700);
    assert.equal(afterInvoice.balanceDue, 4300);
    assert.equal(afterInvoice.paymentStatus, 'partial');

    assert.equal(await creditOf(customer._id), 1300);
    assert.equal(await duesOf(customer._id), 4300);
  });

  it('consumes credit notes oldest-first', async () => {
    const { business, token, customer, product } = await setup();
    const source = await createInvoice(token, customer, product, 20); // 10000
    const target = await createInvoice(token, customer, product, 20);

    const first = await createCreditNote(token, customer, product, source._id, 4); // 2000
    const second = await createCreditNote(token, customer, product, source._id, 3); // 1500
    const third = await createCreditNote(token, customer, product, source._id, 1); // 500

    await stampDate(Invoice, first._id, new Date('2026-01-01'));
    await stampDate(Invoice, second._id, new Date('2026-02-01'));
    await stampDate(Invoice, third._id, new Date('2026-03-01'));

    await applyCredit(token, target._id, 3000).expect(201);

    const rows = await SettlementAllocation.find({ business: business._id, invoice: target._id }).sort({ amount: -1 }).lean();
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [String(row.creditNote), row.amount]),
      [
        [String(first._id), 2000],
        [String(second._id), 1000]
      ]
    );
    assert.equal((await noteOf(third._id)).appliedAmount, 0);
  });

  it('consumes an older credit note before a newer overpayment', async () => {
    const { token, customer, product } = await setup();
    const source = await createInvoice(token, customer, product, 20); // 10000
    const target = await createInvoice(token, customer, product, 20);
    const note = await createCreditNote(token, customer, product, source._id, 2); // 1000
    await stampDate(Invoice, note._id, new Date('2026-01-01'));

    // A 1000 receipt against a 500 invoice parks 500 of unapplied cash.
    const small = await createInvoice(token, customer, product, 1);
    await api()
      .post(`/api/v1/payments/invoices/${small._id}/record`)
      .set(authHeader(token))
      .set(idempotent('pay'))
      .send({ amount: 1000, method: 'cash' })
      .expect(201);
    const payment = await Payment.findOne({ invoice: small._id }).lean();
    await stampDate(Payment, payment._id, new Date('2026-02-01'));

    await applyCredit(token, target._id, 1200).expect(201);

    assert.equal((await noteOf(note._id)).appliedAmount, 1000);
    assert.equal((await Payment.findById(payment._id).lean()).unappliedAmount, 300);

    const afterTarget = await noteOf(target._id);
    // The 200 came from money that really arrived, so it is paid, not credit.
    assert.equal(afterTarget.creditApplied, 1000);
    assert.equal(afterTarget.paidAmount, 200);
    assert.equal(afterTarget.balanceDue, 8800);
  });

  it('rejects an application larger than the available credit and writes nothing', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10);
    const note = await createCreditNote(token, customer, product, invoice._id, 2); // 1000

    const res = await applyCredit(token, invoice._id, 1500).expect(409);
    assert.equal(res.body.details?.code || res.body.code, 'INSUFFICIENT_CREDIT');

    assert.equal(await SettlementAllocation.countDocuments({ business: business._id }), 0);
    assert.equal((await noteOf(note._id)).appliedAmount, 0);
    assert.equal(await creditOf(customer._id), 1000);
  });

  it('rejects an application larger than the invoice balance', async () => {
    const { token, customer, product } = await setup();
    const source = await createInvoice(token, customer, product, 20);
    const target = await createInvoice(token, customer, product, 1); // 500
    await createCreditNote(token, customer, product, source._id, 4); // 2000

    const res = await applyCredit(token, target._id, 800).expect(409);
    assert.equal(res.body.details?.code || res.body.code, 'CREDIT_EXCEEDS_BALANCE');
    assert.equal((await noteOf(target._id)).creditApplied, 0);
  });

  it('settles an invoice fully by credit and drops it out of every dues surface', async () => {
    const { business, token, customer, product } = await setup();
    const source = await createInvoice(token, customer, product, 20); // 10000
    const target = await createInvoice(token, customer, product, 2); // 1000
    await createCreditNote(token, customer, product, source._id, 2); // 1000

    await applyCredit(token, target._id, 1000).expect(201);

    const afterTarget = await noteOf(target._id);
    assert.equal(afterTarget.paymentStatus, 'paid');
    assert.equal(afterTarget.balanceDue, 0);
    assert.equal(afterTarget.paidAmount, 0);
    assert.equal(afterTarget.creditApplied, 1000);

    const outstanding = await api()
      .get(`/api/v1/payments/customers/${customer._id}/outstanding`)
      .set(authHeader(token))
      .expect(200);
    assert.equal(outstanding.body.invoices.some((row) => row.id === String(target._id)), false);

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);
    // Only the 10000 source invoice is still owed.
    assert.equal(report.dues.totalOutstanding, 10000);
    assert.equal(await duesOf(customer._id), 10000);
  });

  it('lists the credit pool oldest-first with per-source remainders', async () => {
    const { token, customer, product } = await setup();
    const source = await createInvoice(token, customer, product, 20);
    const first = await createCreditNote(token, customer, product, source._id, 4); // 2000
    const second = await createCreditNote(token, customer, product, source._id, 2); // 1000
    await stampDate(Invoice, first._id, new Date('2026-01-01'));
    await stampDate(Invoice, second._id, new Date('2026-02-01'));

    await applyCredit(token, source._id, 2500).expect(201);

    const res = await api()
      .get(`/api/v1/payments/customers/${customer._id}/credits`)
      .set(authHeader(token))
      .expect(200);

    // The exhausted note drops off the list; the partly-used one keeps its remainder.
    assert.equal(res.body.availableCredit, 500);
    assert.deepEqual(
      res.body.credits.map((credit) => [credit.id, credit.total, credit.applied, credit.remaining]),
      [[String(second._id), 1000, 500, 500]]
    );
  });

  it('replaying the same idempotency key applies the credit once', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10);
    const note = await createCreditNote(token, customer, product, invoice._id, 2); // 1000
    const key = idempotent('apply-replay');

    await applyCredit(token, invoice._id, 400, key).expect(201);
    await applyCredit(token, invoice._id, 400, key).expect(201);

    assert.equal((await noteOf(note._id)).appliedAmount, 400);
    assert.equal(await SettlementAllocation.countDocuments({ business: business._id, invoice: invoice._id }), 1);
    assert.equal(
      await LedgerEntry.countDocuments({ business: business._id, invoice: invoice._id, account: 'customer_credits', direction: 'debit' }),
      1
    );
  });

  it('lets exactly one of two concurrent applications take the remaining credit', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10);
    const note = await createCreditNote(token, customer, product, invoice._id, 2); // 1000

    const results = await Promise.all([applyCredit(token, invoice._id, 1000), applyCredit(token, invoice._id, 1000)]);

    assert.deepEqual(results.map((res) => res.status).sort(), [201, 409]);
    assert.equal((await noteOf(note._id)).appliedAmount, 1000);
    assert.equal(await SettlementAllocation.countDocuments({ business: business._id, invoice: invoice._id }), 1);
  });
});

describe('credit application ledger', () => {
  it('discharges the liability by settling a receivable', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10);
    await createCreditNote(token, customer, product, invoice._id, 2); // 1000

    const res = await applyCredit(token, invoice._id, 600).expect(201);
    const allocationId = res.body.allocations[0]._id;

    const entries = await LedgerEntry.find({ business: business._id, 'metadata.allocationId': asObjectId(allocationId) }).lean();
    assert.deepEqual(
      entries.map((entry) => `${entry.account}:${entry.direction}`).sort(),
      ['accounts_receivable:credit', 'customer_credits:debit']
    );
    assert.deepEqual([...new Set(entries.map((entry) => entry.amount))], [600]);
  });

  it('keeps the customer_credits balance equal to the available credit', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 20); // 10000
    await createCreditNote(token, customer, product, invoice._id, 4); // 2000

    // An overpayment adds cash-backed credit through a different code path.
    const small = await createInvoice(token, customer, product, 1);
    await api()
      .post(`/api/v1/payments/invoices/${small._id}/record`)
      .set(authHeader(token))
      .set(idempotent('pay'))
      .send({ amount: 1200, method: 'cash' })
      .expect(201);

    const applied = await applyCredit(token, invoice._id, 1500).expect(201);
    await reverseApplication(token, applied.body.allocations[0]._id).expect(200);
    await applyCredit(token, invoice._id, 900).expect(201);

    const entries = await LedgerEntry.find({ business: business._id, account: 'customer_credits' }).lean();
    const net = entries.reduce((sum, entry) => (entry.direction === 'credit' ? sum + entry.amount : sum - entry.amount), 0);
    assert.equal(Math.round(net * 100) / 100, await creditOf(customer._id));
  });
});

describe('reversing a credit application', () => {
  it('gives the credit back and re-opens the invoice', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 2); // 1000
    const note = await createCreditNote(token, customer, product, invoice._id, 2); // 1000

    const applied = await applyCredit(token, invoice._id, 1000).expect(201);
    assert.equal((await noteOf(invoice._id)).paymentStatus, 'paid');
    const allocationId = applied.body.allocations[0]._id;

    const res = await reverseApplication(token, allocationId, { reason: 'Applied to the wrong invoice' }).expect(200);
    assert.equal(res.body.reversed, true);

    const allocation = await SettlementAllocation.findById(allocationId).lean();
    // Soft reversal: the row survives for audit and stops counting.
    assert.notEqual(allocation.reversedAt, null);
    assert.equal(allocation.reversalReason, 'Applied to the wrong invoice');

    const afterInvoice = await noteOf(invoice._id);
    assert.equal(afterInvoice.creditApplied, 0);
    assert.equal(afterInvoice.balanceDue, 1000);
    assert.equal(afterInvoice.paymentStatus, 'unpaid');

    assert.equal((await noteOf(note._id)).appliedAmount, 0);
    assert.equal(await creditOf(customer._id), 1000);
    assert.equal(await duesOf(customer._id), 1000);

    // Originals preserved, compensating pair posted, net ledger effect zero.
    const originals = await LedgerEntry.find({ business: business._id, 'metadata.allocationId': asObjectId(allocationId) }).lean();
    assert.equal(originals.length, 2);
    const reversals = await LedgerEntry.find({ business: business._id, sourceType: 'adjustment' }).lean();
    assert.equal(reversals.length, 2);
    assert.deepEqual(
      reversals.map((entry) => `${entry.account}:${entry.direction}`).sort(),
      ['accounts_receivable:debit', 'customer_credits:credit']
    );
  });

  it('returns unapplied cash to the payment it came from', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 1); // 500
    const target = await createInvoice(token, customer, product, 4); // 2000

    await api()
      .post(`/api/v1/payments/invoices/${invoice._id}/record`)
      .set(authHeader(token))
      .set(idempotent('pay'))
      .send({ amount: 900, method: 'cash' })
      .expect(201);
    const payment = await Payment.findOne({ invoice: invoice._id }).lean();
    assert.equal(payment.unappliedAmount, 400);

    const applied = await applyCredit(token, target._id, 400).expect(201);
    assert.equal((await Payment.findById(payment._id).lean()).unappliedAmount, 0);

    await reverseApplication(token, applied.body.allocations[0]._id).expect(200);

    const afterPayment = await Payment.findById(payment._id).lean();
    assert.equal(afterPayment.unappliedAmount, 400);
    assert.equal(afterPayment.allocatedAmount, 500);
    assert.equal((await noteOf(target._id)).paidAmount, 0);
  });

  it('is a no-op when replayed', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 2);
    await createCreditNote(token, customer, product, invoice._id, 2);

    const applied = await applyCredit(token, invoice._id, 1000).expect(201);
    const allocationId = applied.body.allocations[0]._id;

    await reverseApplication(token, allocationId).expect(200);
    const second = await reverseApplication(token, allocationId).expect(200);

    assert.equal(second.body.reversed, false);
    // The source was released exactly once.
    assert.equal(await creditOf(customer._id), 1000);
    assert.equal(await LedgerEntry.countDocuments({ business: business._id, sourceType: 'adjustment' }), 2);
  });

  it('refuses to reverse the allocation a receipt wrote', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 2);

    await api()
      .post(`/api/v1/payments/invoices/${invoice._id}/record`)
      .set(authHeader(token))
      .set(idempotent('pay'))
      .send({ amount: 400, method: 'cash' })
      .expect(201);

    const allocation = await SettlementAllocation.findOne({ business: business._id, invoice: invoice._id }).lean();
    const res = await reverseApplication(token, allocation._id).expect(409);
    assert.equal(res.body.details?.code || res.body.code, 'NOT_A_CREDIT_APPLICATION');
    assert.equal((await noteOf(invoice._id)).paidAmount, 400);
  });
});

describe('credit note detail', () => {
  it('reports what is left and where the rest went', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 10);
    const note = await createCreditNote(token, customer, product, invoice._id, 4); // 2000

    await applyCredit(token, invoice._id, 750).expect(201);

    const res = await api()
      .get(`/api/v1/documents/credit_note/${note._id}`)
      .set(authHeader(token))
      .expect(200);

    assert.equal(res.body.document.appliedAmount, 750);
    assert.equal(res.body.document.remaining, 1250);
    assert.equal(res.body.document.applications.length, 1);
    assert.equal(res.body.document.applications[0].amount, 750);
    assert.equal(res.body.document.applications[0].invoiceNumber, invoice.invoiceNumber);
  });
});
