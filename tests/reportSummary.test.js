import crypto from 'crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import mongoose from 'mongoose';
import Invoice from '../src/models/Invoice.js';
import Payment from '../src/models/Payment.js';
import { getReportSummary, invalidateReportSummaryCache } from '../src/services/reportService.js';
import { useMongoTestDb } from './helpers/db.js';
import { createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

let invoiceSeq = 0;

const createInvoice = (business, { total, paidAmount = 0, paymentStatus = 'unpaid', documentStatus = 'issued', customer = null, customerName = 'Acme', itemName = 'Widget' } = {}) => {
  invoiceSeq += 1;
  return Invoice.create({
    business: business._id,
    customer,
    documentType: 'invoice',
    documentNumber: `TST-${String(invoiceSeq).padStart(4, '0')}`,
    customerSnapshot: { name: customerName, phone: '9876543210' },
    items: [{ name: itemName, quantity: 1, price: total, total }],
    subtotal: total,
    total,
    paidAmount,
    balanceDue: Math.max(total - paidAmount, 0),
    paymentStatus,
    documentStatus,
    shareToken: crypto.randomUUID()
  });
};

const createPayment = (business, { amount, type = 'receipt', method = 'cash', status = 'completed' } = {}) =>
  Payment.create({ business: business._id, type, method, status, amount, receivedAt: new Date() });

describe('report summary collected sales', () => {
  it('counts partial payments at their collected amount and paid invoices at full total', async () => {
    const { business } = await createTestContext();

    await createInvoice(business, { total: 1000, paidAmount: 1000, paymentStatus: 'paid' });
    await createInvoice(business, { total: 1000, paidAmount: 400, paymentStatus: 'partial' });
    await createInvoice(business, { total: 500, paidAmount: 0, paymentStatus: 'unpaid' });
    // Legacy fully paid doc without a synced paidAmount still counts its total.
    await createInvoice(business, { total: 200, paidAmount: 0, paymentStatus: 'paid' });
    // Cancelled docs never count, even with money recorded.
    await createInvoice(business, { total: 300, paidAmount: 300, paymentStatus: 'paid', documentStatus: 'cancelled' });

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    assert.equal(report.todaySales, 1600);
    assert.equal(report.weeklySales, 1600);
    assert.equal(report.monthlySales, 1600);
    assert.equal(report.rangeSales, 1600);
    assert.equal(report.salesTrend.reduce((sum, day) => sum + day.sales, 0), 1600);
  });

  it('keeps unpaid invoices out of sales totals', async () => {
    const { business } = await createTestContext();

    await createInvoice(business, { total: 750, paidAmount: 0, paymentStatus: 'unpaid' });

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    assert.equal(report.todaySales, 0);
    assert.equal(report.totalInvoices, 1);
  });
});

describe('report summary invoiced (gross) sales', () => {
  it('counts every active invoice at full total regardless of payment status', async () => {
    const { business } = await createTestContext();

    await createInvoice(business, { total: 1000, paidAmount: 1000, paymentStatus: 'paid' });
    await createInvoice(business, { total: 1000, paidAmount: 400, paymentStatus: 'partial' });
    await createInvoice(business, { total: 500, paidAmount: 0, paymentStatus: 'unpaid' });
    // Cancelled excluded from invoiced sales.
    await createInvoice(business, { total: 300, paidAmount: 0, paymentStatus: 'unpaid', documentStatus: 'cancelled' });

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    assert.equal(report.sales.range, 2500);
    assert.equal(report.sales.today, 2500);
    assert.equal(report.sales.invoiceCount, 3);
    // Invoiced (gross) and collected are distinct numbers.
    assert.notEqual(report.sales.range, report.rangeSales);
  });
});

describe('report summary collected from payments', () => {
  it('nets receipts against refunds by receivedAt', async () => {
    const { business } = await createTestContext();

    await createPayment(business, { amount: 1000, method: 'upi' });
    await createPayment(business, { amount: 500, method: 'cash' });
    await createPayment(business, { amount: 200, type: 'refund', method: 'cash' });
    // Non-completed payments are ignored.
    await createPayment(business, { amount: 999, status: 'pending' });

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    assert.equal(report.collected.today, 1300);
    assert.equal(report.collected.range, 1300);
    // Method breakdown counts receipts only.
    const upi = report.collected.methodBreakdown.find((m) => m.method === 'upi');
    assert.equal(upi.amount, 1000);
    assert.equal(upi.count, 1);
  });
});

describe('report summary dues and top customers', () => {
  it('reports outstanding balances and ranks debtors', async () => {
    const { business } = await createTestContext();
    const alpha = new mongoose.Types.ObjectId();
    const beta = new mongoose.Types.ObjectId();
    const gamma = new mongoose.Types.ObjectId();

    await createInvoice(business, { total: 1000, paidAmount: 0, paymentStatus: 'unpaid', customer: alpha, customerName: 'Alpha' });
    await createInvoice(business, { total: 1000, paidAmount: 300, paymentStatus: 'partial', customer: beta, customerName: 'Beta' });
    await createInvoice(business, { total: 500, paidAmount: 500, paymentStatus: 'paid', customer: gamma, customerName: 'Gamma' });

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    // Unpaid 1000 + partial balance 700 = 1700 outstanding.
    assert.equal(report.dues.totalOutstanding, 1700);
    assert.equal(report.dues.unpaidCount, 1);
    assert.equal(report.dues.unpaidAmount, 1000);
    assert.equal(report.dues.partialCount, 1);
    assert.equal(report.dues.partialAmount, 700);
    assert.equal(report.dues.topDebtors[0].name, 'Alpha');
    assert.equal(report.dues.topDebtors[0].balance, 1000);
    // Paid invoice is not a debtor.
    assert.ok(!report.dues.topDebtors.some((d) => d.name === 'Gamma'));

    // Top customers ranked by invoiced sales (Alpha & Beta tie at 1000, Gamma 500).
    assert.equal(report.performance.topCustomers[0].sales, 1000);
    assert.equal(report.performance.averageInvoiceValue, Math.round((2500 / 3) * 100) / 100);
  });
});

describe('report summary customer and product counts', () => {
  it('returns totalCustomers and totalProducts for the business', async () => {
    const { business } = await createTestContext();
    const Customer = (await import('../src/models/Customer.js')).default;
    const Product = (await import('../src/models/Product.js')).default;

    await Customer.create({ business: business._id, name: 'Walk-in', phone: '9000000001' });
    await Customer.create({ business: business._id, name: 'Retail', phone: '9000000002' });
    await Product.create({ business: business._id, name: 'Rice', price: 50, stockQuantity: 10 });

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    assert.equal(report.totalCustomers, 2);
    assert.equal(report.totalProducts, 1);
  });
});

describe('report summary metric trends', () => {
  it('returns a dense per-metric daily series scoped to each card', async () => {
    const { business } = await createTestContext();

    await createInvoice(business, { total: 1000, paidAmount: 1000, paymentStatus: 'paid' });
    await createInvoice(business, { total: 400, paidAmount: 0, paymentStatus: 'unpaid' });

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);
    const { today, month, invoices, pending } = report.metricTrends;

    // 7-day window, one bucket per day, no gaps.
    assert.equal(today.length, 7);
    assert.equal(invoices.length, 7);
    assert.equal(pending.length, 7);
    assert.equal(month.length, new Date().getDate());

    // Today's bucket is the last one and carries this business's real numbers.
    assert.equal(today.at(-1), 1000);
    assert.equal(month.at(-1), 1000);
    assert.equal(invoices.at(-1), 2);
    // Only the unpaid invoice is pending — the paid one is not.
    assert.equal(pending.at(-1), 1);
    // Earlier days had no activity and read as zero rather than being omitted.
    assert.deepEqual(today.slice(0, 6), [0, 0, 0, 0, 0, 0]);
  });
});
