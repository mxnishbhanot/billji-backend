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
import { claimSettlementOnInvoice, releaseSettlementOnInvoice } from '../src/modules/payments/repository.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

/**
 * The two guards that keep settlement honest:
 *
 *  - cancelling an invoice withdraws the credit its own receipts still hold, so the same money
 *    is never both spendable credit and a pending refund;
 *  - an invoice cannot be settled past its total, even by two operations that share no source
 *    counter (a receipt and a credit application share none at all).
 */

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

const createInvoice = async (token, customer, product, quantity, price = 500) => {
  const res = await api()
    .post('/api/v1/invoices')
    .set(authHeader(token))
    .set(idempotent('invoice'))
    .send({
      customerId: customer._id.toString(),
      items: [{ productId: product._id.toString(), quantity, price, taxRate: 0 }],
      taxRate: 0,
      discountType: 'flat',
      discountValue: 0,
      allowOversell: true
    })
    .expect(201);
  return res.body.invoice;
};

const createCreditNote = async (token, customer, product, sourceInvoiceId, quantity, price = 500) => {
  const res = await api()
    .post('/api/v1/documents/credit_note')
    .set(authHeader(token))
    .set(idempotent('credit_note'))
    .send({
      customerId: customer._id.toString(),
      items: [{ productId: product._id.toString(), quantity, price, taxRate: 0 }],
      sourceInvoiceId
    })
    .expect(201);
  return res.body.document;
};

const recordPayment = (token, invoiceId, amount) =>
  api()
    .post(`/api/v1/payments/invoices/${invoiceId}/record`)
    .set(authHeader(token))
    .set(idempotent('pay'))
    .send({ amount, method: 'cash' });

const applyCredit = (token, invoiceId, amount, headers = idempotent('apply')) =>
  api()
    .post(`/api/v1/payments/invoices/${invoiceId}/apply-credit`)
    .set(authHeader(token))
    .set(headers)
    .send({ amount });

const collectDues = (token, customerId, body) =>
  api()
    .post(`/api/v1/payments/customers/${customerId}/record`)
    .set(authHeader(token))
    .set(idempotent('collect'))
    .send(body);

const cancelInvoice = (token, invoiceId) =>
  api().patch(`/api/v1/invoices/${invoiceId}/status`).set(authHeader(token)).send({ status: 'cancelled' });

const docOf = (id) => Invoice.findById(id).lean();
const creditOf = async (customerId) => (await Customer.findById(customerId).lean()).availableCredit;
const codeOf = (res) => res.body.details?.code || res.body.code;
const asObjectId = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));
const money = (value) => Math.round(Number(value || 0) * 100) / 100;

// Net balance of the customer_credits account: what the business says it owes customers.
const creditLedgerBalance = async (businessId) => {
  const entries = await LedgerEntry.find({ business: businessId, account: 'customer_credits' }).lean();
  return money(entries.reduce((sum, entry) => (entry.direction === 'credit' ? sum + entry.amount : sum - entry.amount), 0));
};

const liveSettlement = async (businessId, invoiceId) => {
  const rows = await SettlementAllocation.find({
    business: businessId,
    invoice: asObjectId(invoiceId),
    reversedAt: null
  }).lean();
  return money(rows.reduce((sum, row) => sum + row.amount, 0));
};

const creditsList = async (token, customerId) => {
  const res = await api().get(`/api/v1/payments/customers/${customerId}/credits`).set(authHeader(token)).expect(200);
  return res.body;
};

describe('cancelling an invoice that was overpaid', () => {
  it('withdraws the unapplied credit instead of leaving it spendable', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 20); // 10000

    await recordPayment(token, invoice._id, 12000).expect(201);

    // The overpayment is credit, and the ledger says so.
    assert.equal(await creditOf(customer._id), 2000);
    assert.equal((await creditsList(token, customer._id)).availableCredit, 2000);
    assert.equal(await creditLedgerBalance(business._id), 2000);

    await cancelInvoice(token, invoice._id).expect(200);

    // Cancelling hands the money back as cash owed, so it stops being credit — on the
    // denormalized customer, on the derived pool, and in the ledger, all three agreeing.
    assert.equal(await creditOf(customer._id), 0);
    const pool = await creditsList(token, customer._id);
    assert.equal(pool.availableCredit, 0);
    assert.deepEqual(pool.credits, []);
    assert.equal(await creditLedgerBalance(business._id), 0);

    // The 2000 is represented exactly once, through the existing refund workflow.
    const payment = await Payment.findOne({ business: business._id, invoice: asObjectId(invoice._id) }).lean();
    assert.equal(payment.refundStatus, 'pending');
    assert.equal(payment.refundableAmount, 2000);
    assert.equal(payment.unappliedAmount, 0);
    // Cash that physically arrived is never un-received: the allocation stands.
    assert.equal(payment.allocatedAmount, 10000);
    const allocation = await SettlementAllocation.findOne({ business: business._id, invoice: asObjectId(invoice._id) }).lean();
    assert.equal(allocation.reversedAt, null);
  });

  it('refuses to apply the withdrawn credit to another invoice', async () => {
    const { token, customer, product } = await setup();
    const overpaid = await createInvoice(token, customer, product, 20); // 10000
    const other = await createInvoice(token, customer, product, 10); // 5000

    await recordPayment(token, overpaid._id, 12000).expect(201);
    await cancelInvoice(token, overpaid._id).expect(200);

    const res = await applyCredit(token, other._id, 2000).expect(409);
    assert.equal(codeOf(res), 'INSUFFICIENT_CREDIT');
    assert.equal(res.body.details.availableCredit, 0);

    // Nothing was written on the way to the refusal.
    const after = await docOf(other._id);
    assert.equal(after.creditApplied, 0);
    assert.equal(after.balanceDue, 5000);
  });

  it('withdraws only what is left when part of the credit was already spent', async () => {
    const { business, token, customer, product } = await setup();
    const overpaid = await createInvoice(token, customer, product, 2); // 1000
    const other = await createInvoice(token, customer, product, 4); // 2000

    await recordPayment(token, overpaid._id, 1800).expect(201); // 800 unapplied
    await applyCredit(token, other._id, 300).expect(201);
    assert.equal(await creditOf(customer._id), 500);
    assert.equal(await creditLedgerBalance(business._id), 500);

    await cancelInvoice(token, overpaid._id).expect(200);

    // The 300 already spent stays spent — `other` keeps its settlement — and only the 500
    // still held is withdrawn. Compensating the full original 800 would have driven the
    // account negative and left a liability owed to nobody.
    assert.equal(await creditOf(customer._id), 0);
    assert.equal(await creditLedgerBalance(business._id), 0);

    const payment = await Payment.findOne({ business: business._id, invoice: asObjectId(overpaid._id) }).lean();
    assert.equal(payment.refundableAmount, 500);
    assert.equal(payment.unappliedAmount, 0);

    const settled = await docOf(other._id);
    assert.equal(settled.creditApplied, 0);
    assert.equal(settled.paidAmount, 300);
    assert.equal(settled.balanceDue, 1700);
  });

  it('stays reconciled when an application is reversed after the cancellation', async () => {
    const { business, token, customer, product } = await setup();
    const overpaid = await createInvoice(token, customer, product, 2); // 1000
    const other = await createInvoice(token, customer, product, 4); // 2000

    await recordPayment(token, overpaid._id, 1800).expect(201); // 800 unapplied
    const applied = await applyCredit(token, other._id, 300).expect(201);
    await cancelInvoice(token, overpaid._id).expect(200);
    assert.equal(await creditLedgerBalance(business._id), 0);

    // Reversing the application afterwards hands the 300 back to the receipt it came from.
    // It becomes spendable credit again — the money is still with the business and no longer
    // settles anything — so the ledger and the pool have to move together.
    await api()
      .post(`/api/v1/payments/allocations/${applied.body.allocations[0]._id}/reverse`)
      .set(authHeader(token))
      .set(idempotent('reverse'))
      .send({})
      .expect(200);

    assert.equal(await creditOf(customer._id), 300);
    assert.equal((await creditsList(token, customer._id)).availableCredit, 300);
    assert.equal(await creditLedgerBalance(business._id), 300);

    const payment = await Payment.findOne({ business: business._id, invoice: asObjectId(overpaid._id) }).lean();
    assert.equal(payment.unappliedAmount, 300);
    // The 500 withdrawn by the cancellation stays withdrawn; only the reversed 300 came back.
    assert.equal(payment.refundableAmount, 500);
    assert.equal((await docOf(other._id)).balanceDue, 2000);
  });

  it('withdraws nothing when the whole overpayment had already been applied', async () => {
    const { business, token, customer, product } = await setup();
    const overpaid = await createInvoice(token, customer, product, 2); // 1000
    const other = await createInvoice(token, customer, product, 4); // 2000

    await recordPayment(token, overpaid._id, 1800).expect(201); // 800 unapplied
    await applyCredit(token, other._id, 800).expect(201);
    assert.equal(await creditLedgerBalance(business._id), 0);

    await cancelInvoice(token, overpaid._id).expect(200);

    assert.equal(await creditOf(customer._id), 0);
    assert.equal(await creditLedgerBalance(business._id), 0);
    const payment = await Payment.findOne({ business: business._id, invoice: asObjectId(overpaid._id) }).lean();
    assert.equal(payment.refundableAmount, 0);
  });

  it('withdraws the credit left over by a multi-invoice receipt', async () => {
    const { business, token, customer, product } = await setup();
    const first = await createInvoice(token, customer, product, 2); // 1000
    const second = await createInvoice(token, customer, product, 2); // 1000

    // One receipt settling both bills, with 500 left over as credit. The customer_credits row
    // and the refund flag both hang off the LAST invoice, so cancelling that one withdraws it.
    await collectDues(token, customer._id, {
      amount: 2500,
      method: 'cash',
      invoiceIds: [first._id, second._id]
    }).expect(201);

    assert.equal(await creditOf(customer._id), 500);
    assert.equal(await creditLedgerBalance(business._id), 500);

    await cancelInvoice(token, second._id).expect(200);

    assert.equal(await creditOf(customer._id), 0);
    assert.equal(await creditLedgerBalance(business._id), 0);

    const payment = await Payment.findOne({ business: business._id, type: 'receipt' }).lean();
    assert.equal(payment.refundableAmount, 500);
    assert.equal(payment.unappliedAmount, 0);

    // The other invoice keeps its allocation — a multi-invoice receipt stays valid against
    // the bills that were not cancelled.
    assert.equal(await liveSettlement(business._id, first._id), 1000);
    assert.equal((await docOf(first._id)).balanceDue, 0);
  });

  it('leaves the cancellation of an exactly-paid invoice exactly as it was', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 4); // 2000

    await recordPayment(token, invoice._id, 2000).expect(201);
    await cancelInvoice(token, invoice._id).expect(200);

    // No overpayment, so nothing to withdraw and no customer_credits row to bound.
    const payment = await Payment.findOne({ business: business._id, invoice: asObjectId(invoice._id) }).lean();
    assert.equal(payment.refundStatus, 'pending');
    assert.equal(payment.refundableAmount, 0);
    assert.equal(payment.unappliedAmount, 0);
    assert.equal(await creditOf(customer._id), 0);
    assert.equal(await creditLedgerBalance(business._id), 0);
    const allocation = await SettlementAllocation.findOne({ business: business._id, invoice: asObjectId(invoice._id) }).lean();
    assert.equal(allocation.reversedAt, null);
  });
});

describe('the invoice settlement claim', () => {
  it('never lets reservations exceed the invoice total', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product, 1); // 500
    const doc = await docOf(invoice._id);

    assert.equal(doc.settledAmount, 0);

    // Two claims that each fit the invoice on their own but not together: exactly the shape
    // two settlements from different sources take.
    assert.ok(await claimSettlementOnInvoice(business._id, doc, 400));
    assert.equal(await claimSettlementOnInvoice(business._id, doc, 400), null);

    // The room that is genuinely left is still claimable, and nothing beyond it.
    assert.ok(await claimSettlementOnInvoice(business._id, doc, 100));
    assert.equal(await claimSettlementOnInvoice(business._id, doc, 0.01), null);
    assert.equal((await docOf(invoice._id)).settledAmount, 500);

    // Releasing hands the capacity back, and only down to zero.
    await releaseSettlementOnInvoice(business._id, invoice._id, 100);
    assert.equal((await docOf(invoice._id)).settledAmount, 400);
    assert.equal(await releaseSettlementOnInvoice(business._id, invoice._id, 500), null);
    assert.equal((await docOf(invoice._id)).settledAmount, 400);
  });

  it('refuses a cancelled invoice, and an invoice belonging to another business', async () => {
    const { business, token, customer, product } = await setup();
    const other = await createTestContext();

    const cancelled = await createInvoice(token, customer, product, 1);
    await cancelInvoice(token, cancelled._id).expect(200);
    assert.equal(await claimSettlementOnInvoice(business._id, await docOf(cancelled._id), 100), null);

    const live = await createInvoice(token, customer, product, 1);
    assert.equal(await claimSettlementOnInvoice(other.business._id, await docOf(live._id), 100), null);
    assert.equal((await docOf(live._id)).settledAmount, 0);
  });

  it('tracks the live allocation total through settlement and reversal', async () => {
    const { business, token, customer, product } = await setup();
    const source = await createInvoice(token, customer, product, 4); // 2000
    const target = await createInvoice(token, customer, product, 2); // 1000
    await createCreditNote(token, customer, product, source._id, 1, 400); // 400

    await recordPayment(token, target._id, 250).expect(201);
    const applied = await applyCredit(token, target._id, 400).expect(201);

    const settled = await docOf(target._id);
    assert.equal(settled.settledAmount, 650);
    assert.equal(settled.settledAmount, await liveSettlement(business._id, target._id));

    await api()
      .post(`/api/v1/payments/allocations/${applied.body.allocations[0]._id}/reverse`)
      .set(authHeader(token))
      .set(idempotent('reverse'))
      .send({})
      .expect(200);

    const reversed = await docOf(target._id);
    assert.equal(reversed.settledAmount, 250);
    assert.equal(reversed.settledAmount, await liveSettlement(business._id, target._id));
  });
});

describe('concurrent settlement of one invoice', () => {
  // The invariants every outcome must satisfy, whatever order the racers land in.
  const assertInvoiceSound = async (businessId, invoiceId) => {
    const invoice = await docOf(invoiceId);
    const settled = money(invoice.paidAmount + invoice.creditApplied);
    assert.ok(settled <= money(invoice.total), `settled ${settled} exceeds total ${invoice.total}`);
    assert.ok(invoice.balanceDue >= 0, `negative balanceDue ${invoice.balanceDue}`);
    assert.equal(invoice.balanceDue, money(invoice.total - settled));
    // The denormalized fields and the allocation rows tell the same story.
    assert.equal(settled, await liveSettlement(businessId, invoiceId));
    assert.equal(invoice.settledAmount, settled);
  };

  it('lets only the affordable part through when two DIFFERENT credit sources race', async () => {
    const { business, token, customer, product } = await setup();
    // Source A: a credit note worth 400. Source B: 400 of overpayment cash. The two share no
    // counter, so only the invoice-side claim can stop them over-settling it.
    const noteSource = await createInvoice(token, customer, product, 4); // 2000
    await createCreditNote(token, customer, product, noteSource._id, 1, 400); // 400
    const overpaid = await createInvoice(token, customer, product, 1); // 500
    await recordPayment(token, overpaid._id, 900).expect(201); // 400 unapplied

    assert.equal(await creditOf(customer._id), 800);

    const target = await createInvoice(token, customer, product, 1); // 500

    const results = await Promise.all([applyCredit(token, target._id, 400), applyCredit(token, target._id, 400)]);
    const statuses = results.map((res) => res.status).sort();

    // Both fit the invoice individually; together they do not, so at most one may be a second
    // success and the invoice must never end up over-settled.
    assert.ok(statuses[0] === 201, `expected at least one success, got ${statuses}`);
    await assertInvoiceSound(business._id, target._id);
    assert.ok(money((await docOf(target._id)).creditApplied) <= 500);

    // No credit evaporated and no source was consumed twice: what left the pool is exactly
    // what settled the invoice.
    const settledFromCredit = await liveSettlement(business._id, target._id);
    assert.equal(money(800 - settledFromCredit), await creditOf(customer._id));
    assert.equal(await creditOf(customer._id), (await creditsList(token, customer._id)).availableCredit);
  });

  it('keeps the invoice sound when a receipt and a credit application race', async () => {
    const { business, token, customer, product } = await setup();
    const noteSource = await createInvoice(token, customer, product, 4); // 2000
    await createCreditNote(token, customer, product, noteSource._id, 1, 400); // 400
    const target = await createInvoice(token, customer, product, 1); // 500

    // A receipt has no source counter at all, so this pair is guarded only by the invoice.
    const results = await Promise.all([recordPayment(token, target._id, 500), applyCredit(token, target._id, 400)]);
    assert.ok(results.some((res) => res.status === 201), 'expected at least one to succeed');

    await assertInvoiceSound(business._id, target._id);

    // Cash is never destroyed: whatever the receipt could not settle is unapplied credit.
    const payments = await Payment.find({ business: business._id, invoice: asObjectId(target._id) }).lean();
    for (const payment of payments) {
      assert.equal(money(payment.allocatedAmount + payment.unappliedAmount), money(payment.amount));
    }
  });

  it('keeps the invoice sound when two receipts race', async () => {
    const { business, token, customer, product } = await setup();
    const target = await createInvoice(token, customer, product, 1); // 500

    const results = await Promise.all([recordPayment(token, target._id, 500), recordPayment(token, target._id, 500)]);
    assert.ok(results.some((res) => res.status === 201), 'expected at least one to succeed');

    await assertInvoiceSound(business._id, target._id);

    const payments = await Payment.find({ business: business._id, invoice: asObjectId(target._id) }).lean();
    const received = money(payments.reduce((sum, payment) => sum + payment.amount, 0));
    const accounted = money(payments.reduce((sum, payment) => sum + payment.allocatedAmount + payment.unappliedAmount, 0));
    assert.equal(accounted, received);
  });
});
