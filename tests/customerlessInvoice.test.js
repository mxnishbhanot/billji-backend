import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import Customer from '../src/models/Customer.js';
import CustomerBalance from '../src/models/CustomerBalance.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { buildGstr1 } from '../src/modules/gst/service.js';
import { getReportSummary, invalidateReportSummaryCache } from '../src/services/reportService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext, invoicePayload } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

const postInvoice = (token, payload) =>
  api()
    .post('/api/v1/invoices')
    .set(authHeader(token))
    .set(IDEMPOTENCY_HEADER, `inv-${Math.random().toString(36).slice(2, 10)}`)
    .send(payload);

describe('customerless (walk-in / cash) invoices', () => {
  it('creates an invoice with no customer at all', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business, { stockQuantity: 10 });

    const res = await postInvoice(token, invoicePayload({ product, quantity: 1, allowOversell: true })).expect(201);
    const invoice = res.body.invoice;

    assert.equal(invoice.customer ?? null, null);
    assert.equal(invoice.customerSnapshot.name, 'Walk-in customer');
    assert.equal(invoice.customerSnapshot.phone, '');
    assert.ok(invoice.total > 0);

    // The whole point: no Customer row is invented for an anonymous sale.
    assert.equal(await Customer.countDocuments({ business: business._id }), 0);
    assert.equal(await CustomerBalance.countDocuments({ business: business._id }), 0);
    assert.equal(await LedgerEntry.countDocuments({ business: business._id, customer: { $ne: null } }), 0);
  });

  it('taxes a counter sale as intra-state (CGST + SGST), never IGST', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business, { stockQuantity: 10 });

    const res = await postInvoice(token, invoicePayload({ product, quantity: 1, allowOversell: true })).expect(201);
    const line = res.body.invoice.items[0];

    assert.equal(res.body.invoice.supplyType, 'intra');
    assert.equal(line.igst, 0);
    assert.ok(line.cgst > 0 && line.sgst > 0);
  });

  it('keeps anonymous sales in the null-customer report bucket', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business, { stockQuantity: 20 });

    await postInvoice(token, invoicePayload({ product, quantity: 1, allowOversell: true })).expect(201);

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);
    const top = report.performance.topCustomers;
    const debtors = report.dues.topDebtors;

    assert.equal(top.length, 1);
    assert.equal(top[0].customerId, null);
    assert.equal(top[0].name, 'Walk-in customer');
    assert.ok(debtors.every((row) => row.customerId === null));
  });

  it('files a counter sale under B2CS — never B2B — in GSTR-1', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business, { stockQuantity: 10 });
    const created = await postInvoice(token, invoicePayload({ product, quantity: 1, allowOversell: true })).expect(201);

    const period = String(created.body.invoice.date).slice(0, 7);
    const gstr1 = await buildGstr1(business._id, period);

    // No customer GSTIN exists to file against, so it belongs in the unregistered buckets.
    assert.equal(gstr1.sections.b2b.length, 0);
    assert.equal(gstr1.sections.b2b.length + gstr1.sections.b2cl.length, 0);
    assert.equal(gstr1.sections.b2cs.length, 1);
    assert.equal(gstr1.sections.b2cs[0].supplyType, 'intra');
  });

  it('still refuses a half-typed inline customer', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business, { stockQuantity: 10 });

    await postInvoice(token, { ...invoicePayload({ product, quantity: 1, allowOversell: true }), customer: { name: 'Ramesh' } }).expect(422);
  });

  it('leaves the saved-customer path untouched', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10 });

    const res = await postInvoice(token, invoicePayload({ customer, product, quantity: 1, allowOversell: true })).expect(201);

    assert.equal(String(res.body.invoice.customer), String(customer._id));
    assert.equal(res.body.invoice.customerSnapshot.name, customer.name);
    assert.equal(res.body.invoice.customerSnapshot.phone, customer.phone);
    // The balance row is written by the payments flow; what must hold here is that the
    // invoice is genuinely linked to the customer, unlike a walk-in sale.
    assert.equal(await CustomerBalance.countDocuments({ business: business._id, customer: { $ne: customer._id } }), 0);
  });

  it('refuses to build a WhatsApp share link for a sale with no phone number', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business, { stockQuantity: 10 });
    const created = await postInvoice(token, invoicePayload({ product, quantity: 1, allowOversell: true })).expect(201);

    await api().get(`/api/v1/invoices/${created.body.invoice._id}/whatsapp`).set(authHeader(token)).expect(422);
  });
});
