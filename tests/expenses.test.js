import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Expense from '../src/models/Expense.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { getReportSummary, invalidateReportSummaryCache } from '../src/services/reportService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

let seq = 0;
const idem = (scope) => {
  seq += 1;
  return { [IDEMPOTENCY_HEADER]: `${scope}-${seq}-${Math.random().toString(36).slice(2, 8)}` };
};

const createExpense = async (token, payload, expected = 201) => {
  const res = await api().post('/api/v1/expenses').set(authHeader(token)).set(idem('expense')).send(payload).expect(expected);
  return res.body.expense;
};

const ledgerFor = (businessId, expenseId) =>
  LedgerEntry.find({ business: businessId, sourceId: expenseId }).sort({ account: 1 }).lean();

describe('expense bookkeeping', () => {
  it('posts a balanced debit and credit, crediting cash for a cash payment', async () => {
    const { business, token } = await createTestContext();

    const expense = await createExpense(token, { amount: 5000, category: 'rent', paymentMethod: 'cash', vendorName: 'Landlord' });

    assert.equal(expense.total, 5000);
    const entries = await ledgerFor(business._id, expense._id);
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => `${entry.account}:${entry.direction}:${entry.amount}`),
      ['cash:credit:5000', 'expenses:debit:5000']
    );
  });

  it('credits bank for anything that is not cash', async () => {
    const { business, token } = await createTestContext();

    const expense = await createExpense(token, { amount: 1200, category: 'utilities', paymentMethod: 'upi' });

    const entries = await ledgerFor(business._id, expense._id);
    assert.ok(entries.some((entry) => entry.account === 'bank' && entry.direction === 'credit'));
    assert.ok(!entries.some((entry) => entry.account === 'cash'));
  });

  it('derives the total from amount plus tax rather than trusting the client', async () => {
    const { token } = await createTestContext();

    // A wrong total in the request must not survive.
    const expense = await createExpense(token, { amount: 1000, taxAmount: 180, total: 99999, category: 'purchase' });

    assert.equal(expense.amount, 1000);
    assert.equal(expense.taxAmount, 180);
    assert.equal(expense.total, 1180);
  });

  it('re-posts the ledger when an expense is edited', async () => {
    const { business, token } = await createTestContext();
    const expense = await createExpense(token, { amount: 500, category: 'transport', paymentMethod: 'cash' });

    await api()
      .patch(`/api/v1/expenses/${expense._id}`)
      .set(authHeader(token))
      .send({ amount: 900, category: 'transport', paymentMethod: 'upi' })
      .expect(200);

    const entries = await ledgerFor(business._id, expense._id);
    // Old rows are replaced, not stacked: still exactly one pair, now for 900 via bank.
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.amount === 900));
    assert.ok(entries.some((entry) => entry.account === 'bank'));
  });
});

describe('deleting an expense', () => {
  it('voids the row and posts compensating entries instead of erasing history', async () => {
    const { business, token } = await createTestContext();
    const expense = await createExpense(token, { amount: 2000, category: 'salary', paymentMethod: 'bank_transfer' });

    await api().delete(`/api/v1/expenses/${expense._id}`).set(authHeader(token)).expect(200);

    // The record survives, flagged.
    const stored = await Expense.findById(expense._id).lean();
    assert.ok(stored.voidedAt);

    // Two originals + two reversals, netting to zero.
    const entries = await ledgerFor(business._id, expense._id);
    assert.equal(entries.length, 4);
    const net = entries.reduce((sum, entry) => sum + (entry.direction === 'debit' ? entry.amount : -entry.amount), 0);
    assert.equal(net, 0);
    assert.equal(entries.filter((entry) => entry.sourceType === 'adjustment').length, 2);
  });

  it('hides voided expenses from the list but keeps them out of nothing else', async () => {
    const { token } = await createTestContext();
    const kept = await createExpense(token, { amount: 100, category: 'other' });
    const removed = await createExpense(token, { amount: 700, category: 'other' });
    await api().delete(`/api/v1/expenses/${removed._id}`).set(authHeader(token)).expect(200);

    const list = await api().get('/api/v1/expenses').set(authHeader(token)).expect(200);

    assert.equal(list.body.expenses.length, 1);
    assert.equal(list.body.expenses[0]._id, kept._id);
    // Summary follows the same rule.
    assert.equal(list.body.summary.total, 100);
  });

  it('is idempotent and refuses to edit a deleted expense', async () => {
    const { token } = await createTestContext();
    const expense = await createExpense(token, { amount: 300, category: 'other' });

    await api().delete(`/api/v1/expenses/${expense._id}`).set(authHeader(token)).expect(200);
    await api().delete(`/api/v1/expenses/${expense._id}`).set(authHeader(token)).expect(200);

    await api()
      .patch(`/api/v1/expenses/${expense._id}`)
      .set(authHeader(token))
      .send({ amount: 400, category: 'other' })
      .expect(409);
  });
});

describe('expense listing', () => {
  it('filters by category and date, and totals what it shows', async () => {
    const { token } = await createTestContext();
    await createExpense(token, { amount: 1000, category: 'rent', date: '2026-06-10' });
    await createExpense(token, { amount: 500, category: 'transport', date: '2026-06-20' });
    await createExpense(token, { amount: 300, category: 'rent', date: '2026-07-05' });

    const byCategory = await api().get('/api/v1/expenses?category=rent').set(authHeader(token)).expect(200);
    assert.equal(byCategory.body.expenses.length, 2);

    const byDate = await api().get('/api/v1/expenses?from=2026-06-01&to=2026-06-30').set(authHeader(token)).expect(200);
    assert.equal(byDate.body.expenses.length, 2);
    assert.equal(byDate.body.summary.total, 1500);
    assert.equal(byDate.body.summary.byCategory.find((row) => row.category === 'rent').total, 1000);
  });

  it('never shows another business\'s expenses', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();
    await createExpense(theirs.token, { amount: 9999, category: 'rent' });

    const res = await api().get('/api/v1/expenses').set(authHeader(mine.token)).expect(200);

    assert.equal(res.body.expenses.length, 0);
    assert.equal(res.body.summary.total, 0);
  });

  it('rejects an unknown category and a negative amount', async () => {
    const { token } = await createTestContext();

    await createExpense(token, { amount: 100, category: 'yacht' }, 422);
    await createExpense(token, { amount: -5, category: 'other' }, 422);
  });

  it('denies a staff member, who has no expense permissions', async () => {
    const { token } = await createTestContext({ roleKey: 'staff' });

    await api().get('/api/v1/expenses').set(authHeader(token)).expect(403);
    await api().post('/api/v1/expenses').set(authHeader(token)).set(idem('deny')).send({ amount: 10 }).expect(403);
  });

  it('lets a viewer read but not record', async () => {
    const { token } = await createTestContext({ roleKey: 'viewer' });

    await api().get('/api/v1/expenses').set(authHeader(token)).expect(200);
    await api().post('/api/v1/expenses').set(authHeader(token)).set(idem('viewer')).send({ amount: 10 }).expect(403);
  });
});

describe('profit reporting', () => {
  it('reports gross profit from item cost and nets expenses off it', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    // Sells for 500, cost 300 => 200 gross per unit.
    const product = await createProduct(business, { price: 500, purchasePrice: 300, stockQuantity: 100 });

    await api()
      .post('/api/v1/invoices')
      .set(authHeader(token))
      .set(idem('invoice'))
      .send({ customerId: customer._id.toString(), items: [{ productId: product._id.toString(), quantity: 2, price: 500 }], taxRate: 0, discountValue: 0, allowOversell: true })
      .expect(201);

    await createExpense(token, { amount: 250, category: 'transport', paymentMethod: 'cash' });

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    assert.equal(report.profit.revenue, 1000);
    assert.equal(report.profit.costOfGoods, 600);
    assert.equal(report.profit.grossProfit, 400);
    assert.equal(report.profit.expenses, 250);
    assert.equal(report.profit.netProfit, 150);
    assert.equal(report.profit.expenseCount, 1);
    // Every line had a purchase price, so the margin is fully backed.
    assert.equal(report.profit.costCoverage, 100);
  });

  it('flags partial cost coverage rather than pretending the margin is exact', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const withCost = await createProduct(business, { name: 'Priced', price: 500, purchasePrice: 300, stockQuantity: 50 });
    const withoutCost = await createProduct(business, { name: 'Unpriced', sku: 'NOCOST', price: 400, purchasePrice: 0, stockQuantity: 50 });

    await api()
      .post('/api/v1/invoices')
      .set(authHeader(token))
      .set(idem('invoice'))
      .send({
        customerId: customer._id.toString(),
        items: [
          { productId: withCost._id.toString(), quantity: 1, price: 500 },
          { productId: withoutCost._id.toString(), quantity: 1, price: 400 }
        ],
        taxRate: 0,
        discountValue: 0,
        allowOversell: true
      })
      .expect(201);

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    assert.equal(report.profit.costOfGoods, 300);
    assert.equal(report.profit.costCoverage, 50);
  });

  it('excludes voided expenses from net profit', async () => {
    const { business, token } = await createTestContext();
    const expense = await createExpense(token, { amount: 400, category: 'other' });

    invalidateReportSummaryCache(business._id);
    assert.equal((await getReportSummary(business._id)).profit.expenses, 400);

    await api().delete(`/api/v1/expenses/${expense._id}`).set(authHeader(token)).expect(200);

    invalidateReportSummaryCache(business._id);
    assert.equal((await getReportSummary(business._id)).profit.expenses, 0);
  });
});
