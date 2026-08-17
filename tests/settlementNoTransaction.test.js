import mongoose from 'mongoose';
import request from 'supertest';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import app from '../src/app.js';
import Customer from '../src/models/Customer.js';
import Invoice from '../src/models/Invoice.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import Payment from '../src/models/Payment.js';
import SettlementAllocation from '../src/models/SettlementAllocation.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { claimSettlementOnInvoice } from '../src/modules/payments/repository.js';
import { withTransaction } from '../src/utils/transaction.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

/**
 * The settlement guards WITHOUT a transaction session.
 *
 * Every other suite runs against MongoMemoryReplSet, where `session.withTransaction` retries
 * the whole callback on a write conflict — which hides the failure modes these guards exist
 * for. Two settlements that both write the same Invoice document are serialised by the
 * transaction, so a stale `$set` of `settledAmount`, or a cancellation that persists its
 * status only at the end, cost nothing there. They cost money on the no-session path.
 *
 * This file forces that path for the whole process: the first `withTransaction` call is made
 * to see the error a standalone mongod raises, which caches "transactions unsupported" in the
 * module for the rest of the run. Node's test runner gives each file its own process, so the
 * cache cannot leak into another suite.
 */

useMongoTestDb();

// Exactly what a standalone mongod answers when a transaction is attempted.
const unsupported = () =>
  Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), {
    code: 20,
    codeName: 'IllegalOperation'
  });

before(async () => {
  const startSession = mongoose.startSession.bind(mongoose);
  mongoose.startSession = async (...args) => {
    const session = await startSession(...args);
    session.withTransaction = async () => {
      throw unsupported();
    };
    return session;
  };

  // Triggers the fallback and caches it. The assertion is the point: if this ever returns a
  // session, every test below would silently be testing the transactional path instead.
  const session = await withTransaction((current) => current);
  assert.equal(session, undefined, 'expected the transactionless fallback to be active');

  mongoose.startSession = startSession;

  // And it stays off — the cached answer short-circuits before a session is ever started.
  assert.equal(await withTransaction((current) => current), undefined);
});

const api = () => request(app);

let seq = 0;
const idempotent = (scope) => {
  seq += 1;
  return { [IDEMPOTENCY_HEADER]: `${scope}-${seq}-${Math.random().toString(36).slice(2, 8)}` };
};

const money = (value) => Math.round(Number(value || 0) * 100) / 100;
const asObjectId = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

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

const applyCredit = (token, invoiceId, amount) =>
  api()
    .post(`/api/v1/payments/invoices/${invoiceId}/apply-credit`)
    .set(authHeader(token))
    .set(idempotent('apply'))
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

const liveSettlement = async (businessId, invoiceId) => {
  const rows = await SettlementAllocation.find({
    business: businessId,
    invoice: asObjectId(invoiceId),
    reversedAt: null
  }).lean();
  return money(rows.reduce((sum, row) => sum + row.amount, 0));
};

const ledgerNet = async (businessId) => {
  const entries = await LedgerEntry.find({ business: businessId }).lean();
  const byAccount = {};
  let debits = 0;
  let credits = 0;
  for (const entry of entries) {
    const signed = entry.direction === 'debit' ? entry.amount : -entry.amount;
    byAccount[entry.account] = money((byAccount[entry.account] || 0) + signed);
    if (entry.direction === 'debit') debits = money(debits + entry.amount);
    else credits = money(credits + entry.amount);
  }
  return { byAccount, debits, credits };
};

// The invariants no interleaving may break.
const assertInvoiceSound = async (businessId, invoiceId) => {
  const invoice = await docOf(invoiceId);
  const live = await liveSettlement(businessId, invoiceId);
  assert.ok(live <= money(invoice.total), `live settlement ${live} exceeds total ${invoice.total}`);
  assert.equal(money(invoice.settledAmount), live, 'settledAmount drifted from the live allocation total');
};

// Every rupee that reached a receipt is still accounted for on it.
const assertCashConserved = async (businessId) => {
  const payments = await Payment.find({ business: businessId, type: 'receipt' }).lean();
  for (const payment of payments) {
    assert.equal(
      money(payment.allocatedAmount + payment.unappliedAmount + payment.refundableAmount),
      money(payment.amount),
      `receipt ${payment._id} does not add up`
    );
  }
};

describe('settlement without a transaction session', () => {
  it('lets two settlements that both fit land, and keeps settledAmount on the allocations', async () => {
    const { business, token, customer, product } = await setup();
    const noteSource = await createInvoice(token, customer, product, 4); // 2000
    await createCreditNote(token, customer, product, noteSource._id, 1, 400); // 400 of credit
    const target = await createInvoice(token, customer, product, 2); // 1000

    // 400 of cash and 400 of credit. Both fit; they share no source counter, so only the
    // invoice-side reservation relates them — and a `$set` of settledAmount computed from
    // either one's stale view would erase the other's.
    const results = await Promise.all([recordPayment(token, target._id, 400), applyCredit(token, target._id, 400)]);
    assert.deepEqual(
      results.map((res) => res.status),
      [201, 201],
      `expected both to succeed, got ${results.map((res) => JSON.stringify(res.body)).join(' | ')}`
    );

    assert.equal(await liveSettlement(business._id, target._id), 800);
    assert.equal(money((await docOf(target._id)).settledAmount), 800);
    await assertInvoiceSound(business._id, target._id);
  });

  // The clobber itself, isolated from any timing. Every settlement workflow loads the invoice,
  // does its work, and saves — and the old code recomputed `settledAmount` from the figures it
  // had read at the start. A reservation taken by another workflow in between was erased by
  // that save, handing the same capacity out twice.
  it('does not let a document save erase a reservation taken after it was loaded', async () => {
    const { business, token, customer, product } = await setup();
    const target = await createInvoice(token, customer, product, 2); // 1000

    // What every workflow holds: an invoice read before the concurrent claim landed.
    const stale = await Invoice.findById(target._id);

    assert.ok(await claimSettlementOnInvoice(business._id, await docOf(target._id), 400));
    assert.equal(money((await docOf(target._id)).settledAmount), 400);

    // The stale document settles 300 of its own and recomputes the counter from what it read
    // at the start (0 + 300), which is what the old code did. Saving that must not land: the
    // truth is 400 reserved by someone else, and 300 would hand that capacity out twice.
    stale.paidAmount = 300;
    stale.settledAmount = 300;
    stale.balanceDue = 700;
    await stale.save();

    assert.equal(money((await docOf(target._id)).settledAmount), 400, 'a stale save erased the reservation');

    // And with the field genuinely absent — an invoice written before it existed — the
    // schema default must not be saved over the reservation either.
    await Invoice.collection.updateOne({ _id: asObjectId(target._id) }, { $unset: { settledAmount: '' } });
    const legacy = await Invoice.findById(target._id);
    await Invoice.collection.updateOne({ _id: asObjectId(target._id) }, { $set: { settledAmount: 250 } });
    legacy.paidAmount = 0;
    await legacy.save();
    assert.equal(money((await docOf(target._id)).settledAmount), 250, 'a hydrated default erased the reservation');
  });

  it('never lets two settlements exceed the invoice when only one can fit', async () => {
    const { business, token, customer, product } = await setup();
    const noteSource = await createInvoice(token, customer, product, 4); // 2000
    await createCreditNote(token, customer, product, noteSource._id, 2, 350); // 700 of credit
    const target = await createInvoice(token, customer, product, 2); // 1000

    const results = await Promise.all([recordPayment(token, target._id, 700), applyCredit(token, target._id, 700)]);
    assert.ok(results.some((res) => res.status === 201), 'expected at least one to succeed');

    const live = await liveSettlement(business._id, target._id);
    assert.ok(live <= 1000, `settled ${live} on a 1000 invoice`);
    await assertInvoiceSound(business._id, target._id);
    await assertCashConserved(business._id);

    // Credit that was not spent is still spendable; credit that was spent settled something.
    const creditSpent = money(
      (
        await SettlementAllocation.find({
          business: business._id,
          invoice: asObjectId(target._id),
          source: 'credit_note',
          reversedAt: null
        }).lean()
      ).reduce((sum, row) => sum + row.amount, 0)
    );
    assert.equal(await creditOf(customer._id), money(700 - creditSpent));
  });

  it('does not let a credit application land on an invoice being cancelled', async () => {
    const { business, token, customer, product } = await setup();
    const noteSource = await createInvoice(token, customer, product, 4); // 2000
    await createCreditNote(token, customer, product, noteSource._id, 1, 400); // 400 of credit
    const target = await createInvoice(token, customer, product, 2); // 1000

    await Promise.all([cancelInvoice(token, target._id), applyCredit(token, target._id, 400)]);

    const invoice = await docOf(target._id);
    assert.equal(invoice.documentStatus, 'cancelled');
    // Either the application never landed, or the cancellation swept it back. Nothing may
    // still be settling a cancelled invoice, and the credit must be spendable again.
    assert.equal(await liveSettlement(business._id, target._id), 0);
    assert.equal(money(invoice.settledAmount), 0);
    assert.equal(await creditOf(customer._id), 400, 'credit was consumed with nothing to show for it');
  });

  it('does not lose a payment that races the cancellation of its invoice', async () => {
    const { business, token, customer, product } = await setup();
    const target = await createInvoice(token, customer, product, 2); // 1000

    await Promise.all([cancelInvoice(token, target._id), recordPayment(token, target._id, 400)]);

    const invoice = await docOf(target._id);
    assert.equal(invoice.documentStatus, 'cancelled');
    await assertInvoiceSound(business._id, target._id);
    await assertCashConserved(business._id);
    // Cash that arrived is never spendable credit on a cancelled invoice.
    assert.equal(await creditOf(customer._id), 0);
  });

  it('does not lose a multi-invoice receipt that races the cancellation of one of its invoices', async () => {
    const { business, token, customer, product } = await setup();
    const first = await createInvoice(token, customer, product, 2); // 1000
    const second = await createInvoice(token, customer, product, 2); // 1000

    await Promise.all([
      cancelInvoice(token, first._id),
      collectDues(token, customer._id, { amount: 2000, method: 'cash', invoiceIds: [first._id, second._id] })
    ]);

    assert.equal((await docOf(first._id)).documentStatus, 'cancelled');
    await assertInvoiceSound(business._id, first._id);
    await assertInvoiceSound(business._id, second._id);
    await assertCashConserved(business._id);
    // Nothing may still be settling the cancelled invoice.
    assert.equal(await liveSettlement(business._id, first._id), 0);
  });

  it('makes the cancelled invoice`s share of a shared receipt refundable, not lost', async () => {
    const { business, token, customer, product } = await setup();
    const first = await createInvoice(token, customer, product, 2); // 1000
    const second = await createInvoice(token, customer, product, 2); // 1000

    // One receipt, three destinations: 1000 to each invoice and 500 left as credit. The
    // Payment's own `invoice` field names only the LAST invoice, so cancelling the first one
    // is the case every `Payment.invoice`-keyed predicate misses.
    await collectDues(token, customer._id, {
      amount: 2500,
      method: 'cash',
      invoiceIds: [first._id, second._id]
    }).expect(201);

    assert.equal(await creditOf(customer._id), 500);

    await cancelInvoice(token, first._id).expect(200);

    // The cancelled invoice settles nothing any more.
    assert.equal(await liveSettlement(business._id, first._id), 0);
    assert.equal(money((await docOf(first._id)).settledAmount), 0);

    // The other invoice is untouched — a shared receipt stays valid against the bills that stand.
    assert.equal(await liveSettlement(business._id, second._id), 1000);
    assert.equal(money((await docOf(second._id)).balanceDue), 0);

    // The 1000 is represented exactly once, as refundable cash on the receipt.
    const payment = await Payment.findOne({ business: business._id, type: 'receipt' }).lean();
    assert.equal(money(payment.amount), 2500);
    assert.equal(money(payment.allocatedAmount), 1000);
    assert.equal(money(payment.unappliedAmount), 500);
    assert.equal(money(payment.refundableAmount), 1000);
    assert.equal(payment.refundStatus, 'pending');
    await assertCashConserved(business._id);

    // Not also spendable: the pool still holds only the 500 that was genuinely left over.
    assert.equal(await creditOf(customer._id), 500);

    // And the books balance, with cash showing the 1500 the business actually keeps.
    const ledger = await ledgerNet(business._id);
    assert.equal(ledger.debits, ledger.credits, 'ledger no longer balances');
    assert.equal(ledger.byAccount.cash, 1500);
    assert.equal(ledger.byAccount.customer_credits, -500); // net credit: the liability still owed
  });

  it('cancels the last invoice of a shared receipt without writing off the other invoice`s cash', async () => {
    const { business, token, customer, product } = await setup();
    const first = await createInvoice(token, customer, product, 2); // 1000
    const second = await createInvoice(token, customer, product, 2); // 1000

    await collectDues(token, customer._id, {
      amount: 2500,
      method: 'cash',
      invoiceIds: [first._id, second._id]
    }).expect(201);

    await cancelInvoice(token, second._id).expect(200);

    // The first invoice keeps its settlement, so the cash that settled it stays on the books.
    assert.equal(await liveSettlement(business._id, first._id), 1000);
    const ledger = await ledgerNet(business._id);
    assert.equal(ledger.debits, ledger.credits, 'ledger no longer balances');
    assert.equal(ledger.byAccount.cash, 1000);
    await assertCashConserved(business._id);
  });

  it('repairs an invoice whose settledAmount predates the field instead of over-settling it', async () => {
    const { business, token, customer, product } = await setup();
    const target = await createInvoice(token, customer, product, 2); // 1000

    await recordPayment(token, target._id, 400).expect(201);
    // Exactly what a document written before `settledAmount` existed looks like.
    await Invoice.collection.updateOne({ _id: asObjectId(target._id) }, { $unset: { settledAmount: '' } });
    assert.equal((await docOf(target._id)).settledAmount, undefined);

    // It must still be settleable — a missing field cannot make an invoice unusable...
    await recordPayment(token, target._id, 700).expect(201);

    // ...and it must not hand out capacity the allocations already used: 400 + 600 = 1000,
    // with the last 100 parked as credit rather than settling anything.
    assert.equal(await liveSettlement(business._id, target._id), 1000);
    assert.equal(money((await docOf(target._id)).settledAmount), 1000);
    await assertCashConserved(business._id);
    assert.equal(await creditOf(customer._id), 100);
  });

  it('repairs a stale settledAmount of 0 before measuring new capacity against it', async () => {
    const { business, token, customer, product } = await setup();
    const target = await createInvoice(token, customer, product, 2); // 1000

    await recordPayment(token, target._id, 700).expect(201);
    await Invoice.collection.updateOne({ _id: asObjectId(target._id) }, { $set: { settledAmount: 0 } });

    await recordPayment(token, target._id, 300).expect(201);

    assert.equal(money((await docOf(target._id)).settledAmount), 1000);
    assert.equal(await liveSettlement(business._id, target._id), 1000);
    await assertInvoiceSound(business._id, target._id);
  });

  it('leaves a correct settledAmount alone', async () => {
    const { business, token, customer, product } = await setup();
    const target = await createInvoice(token, customer, product, 2); // 1000

    await recordPayment(token, target._id, 400).expect(201);
    assert.equal(money((await docOf(target._id)).settledAmount), 400);

    await recordPayment(token, target._id, 200).expect(201);
    assert.equal(money((await docOf(target._id)).settledAmount), 600);
    await assertInvoiceSound(business._id, target._id);
  });
});
