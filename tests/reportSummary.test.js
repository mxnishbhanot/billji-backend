import crypto from 'crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Invoice from '../src/models/Invoice.js';
import { getReportSummary, invalidateReportSummaryCache } from '../src/services/reportService.js';
import { useMongoTestDb } from './helpers/db.js';
import { createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

let invoiceSeq = 0;

const createInvoice = (business, { total, paidAmount = 0, paymentStatus = 'unpaid', documentStatus = 'issued' } = {}) => {
  invoiceSeq += 1;
  return Invoice.create({
    business: business._id,
    documentType: 'invoice',
    documentNumber: `TST-${String(invoiceSeq).padStart(4, '0')}`,
    customerSnapshot: { name: 'Acme', phone: '9876543210' },
    items: [{ name: 'Widget', quantity: 1, price: total, total }],
    subtotal: total,
    total,
    paidAmount,
    balanceDue: Math.max(total - paidAmount, 0),
    paymentStatus,
    documentStatus,
    shareToken: crypto.randomUUID()
  });
};

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
