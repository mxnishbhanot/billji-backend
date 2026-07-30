import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import Payment from '../src/models/Payment.js';
import Product from '../src/models/Product.js';
import StockMovement from '../src/models/StockMovement.js';
import Vendor from '../src/models/Vendor.js';
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

const createVendor = async (token, overrides = {}) => {
  const res = await api()
    .post('/api/v1/purchases/vendors')
    .set(authHeader(token))
    .send({ name: 'Wholesale Traders', phone: '9812345678', gstNumber: '27AAPFU0939F1ZV', ...overrides })
    .expect(201);
  return res.body.vendor;
};

const createPurchase = async (token, payload, expected = 201) => {
  const res = await api().post('/api/v1/purchases').set(authHeader(token)).set(idem('purchase')).send(payload).expect(expected);
  return res.body.purchase;
};

const setup = async () => {
  const context = await createTestContext();
  const vendor = await createVendor(context.token);
  const product = await createProduct(context.business, { name: 'Rice 5kg', price: 500, purchasePrice: 300, stockQuantity: 10 });
  return { ...context, vendor, product };
};

const billFor = (vendor, product, overrides = {}) => ({
  vendorId: vendor._id,
  items: [{ productId: product._id.toString(), name: product.name, quantity: 20, price: 320, taxRate: 5, hsn: '1006' }],
  vendorBillNumber: 'SUP/2026/88',
  ...overrides
});

const stockOf = async (id) => (await Product.findById(id).lean()).stockQuantity;
const ledgerFor = (businessId, sourceId) => LedgerEntry.find({ business: businessId, sourceId }).sort({ account: 1 }).lean();

describe('receiving a purchase bill', () => {
  it('adds stock, numbers the bill, and posts inventory against payables', async () => {
    const { business, token, vendor, product } = await setup();

    const bill = await createPurchase(token, billFor(vendor, product));

    assert.match(bill.billNumber, /^PUR-/);
    assert.equal(bill.vendorBillNumber, 'SUP/2026/88');
    // 20 units received on top of 10.
    assert.equal(await stockOf(product._id), 30);
    const movements = await StockMovement.find({ business: business._id, product: product._id, type: 'purchase' }).lean();
    assert.equal(movements.length, 1);
    assert.equal(movements[0].quantityChange, 20);
    assert.equal(movements[0].stockAfter, 30);

    // 20 x 320 = 6400 + 5% = 6720.
    assert.equal(bill.subtotal, 6400);
    assert.equal(bill.total, 6720);
    assert.equal(bill.balanceDue, 6720);
    assert.equal(bill.paymentStatus, 'unpaid');

    const entries = await ledgerFor(business._id, bill._id);
    assert.deepEqual(
      entries.map((entry) => `${entry.account}:${entry.direction}:${entry.amount}`),
      ['accounts_payable:credit:6720', 'inventory:debit:6720']
    );
  });

  it('updates the product cost price so margin stays current', async () => {
    const { token, vendor, product } = await setup();
    assert.equal((await Product.findById(product._id).lean()).purchasePrice, 300);

    await createPurchase(token, billFor(vendor, product));

    // Bought at 320 this time.
    assert.equal((await Product.findById(product._id).lean()).purchasePrice, 320);
  });

  it('raises the vendor payable', async () => {
    const { token, vendor, product } = await setup();
    await createPurchase(token, billFor(vendor, product));

    const res = await api().get(`/api/v1/purchases/vendors/${vendor._id}/outstanding`).set(authHeader(token)).expect(200);

    assert.equal(res.body.billed, 6720);
    assert.equal(res.body.paid, 0);
    assert.equal(res.body.outstandingPayable, 6720);
    assert.equal(res.body.bills.length, 1);
    assert.equal((await Vendor.findById(vendor._id).lean()).outstandingPayable, 6720);
  });

  it('charges IGST when the vendor is in another state', async () => {
    const { business, token, product } = await setup();
    business.gstNumber = '27AAPFU0939F1ZV';
    await business.save();
    const delhiVendor = await createVendor(token, { name: 'Delhi Supplier', gstNumber: '07AAPFU0939F1ZV' });

    const bill = await createPurchase(token, billFor(delhiVendor, product));

    assert.equal(bill.supplyType, 'inter');
    assert.equal(bill.igstTotal, 320);
    assert.equal(bill.cgstTotal, 0);
  });

  it('handles a non-stock line without inventing a movement', async () => {
    const { business, token, vendor } = await setup();

    const bill = await createPurchase(token, {
      vendorId: vendor._id,
      items: [{ name: 'Freight', quantity: 1, price: 800, taxRate: 0 }]
    });

    assert.equal(bill.total, 800);
    assert.equal(await StockMovement.countDocuments({ business: business._id, documentNumber: bill.billNumber }), 0);
  });

  it('rejects a bill with no vendor or no items', async () => {
    const { token, vendor, product } = await setup();

    await createPurchase(token, { items: billFor(vendor, product).items }, 422);
    await createPurchase(token, { vendorId: vendor._id, items: [] }, 422);
  });
});

describe('paying a vendor', () => {
  it('records a part payment against a bill and reduces the payable', async () => {
    const { business, token, vendor, product } = await setup();
    const bill = await createPurchase(token, billFor(vendor, product));

    const res = await api()
      .post(`/api/v1/purchases/vendors/${vendor._id}/payments`)
      .set(authHeader(token))
      .set(idem('vendor-pay'))
      .send({ amount: 2720, method: 'upi', billId: bill._id })
      .expect(201);

    assert.equal(res.body.bill.paidAmount, 2720);
    assert.equal(res.body.bill.balanceDue, 4000);
    assert.equal(res.body.bill.paymentStatus, 'partial');
    assert.equal(res.body.outstandingPayable, 4000);

    // Payable down, bank down.
    const entries = await ledgerFor(business._id, res.body.payment._id);
    assert.deepEqual(
      entries.map((entry) => `${entry.account}:${entry.direction}`),
      ['accounts_payable:debit', 'bank:credit']
    );
  });

  it('marks the bill paid when settled in full', async () => {
    const { token, vendor, product } = await setup();
    const bill = await createPurchase(token, billFor(vendor, product));

    const res = await api()
      .post(`/api/v1/purchases/vendors/${vendor._id}/payments`)
      .set(authHeader(token))
      .set(idem('vendor-pay'))
      .send({ amount: 6720, method: 'cash', billId: bill._id })
      .expect(201);

    assert.equal(res.body.bill.paymentStatus, 'paid');
    assert.equal(res.body.outstandingPayable, 0);
    // Cash, not bank, for a cash payment.
    const entries = await ledgerFor(res.body.payment.business, res.body.payment._id);
    assert.ok(entries.some((entry) => entry.account === 'cash' && entry.direction === 'credit'));
  });

  it('refuses to overpay a bill or pay one belonging to another vendor', async () => {
    const { token, vendor, product } = await setup();
    const bill = await createPurchase(token, billFor(vendor, product));
    const otherVendor = await createVendor(token, { name: 'Someone Else', phone: '9800000000' });

    await api()
      .post(`/api/v1/purchases/vendors/${vendor._id}/payments`)
      .set(authHeader(token))
      .set(idem('overpay'))
      .send({ amount: 10000, billId: bill._id })
      .expect(422);

    await api()
      .post(`/api/v1/purchases/vendors/${otherVendor._id}/payments`)
      .set(authHeader(token))
      .set(idem('wrong-vendor'))
      .send({ amount: 100, billId: bill._id })
      .expect(422);
  });

  it('allows an on-account payment with no bill attached', async () => {
    const { token, vendor, product } = await setup();
    await createPurchase(token, billFor(vendor, product));

    const res = await api()
      .post(`/api/v1/purchases/vendors/${vendor._id}/payments`)
      .set(authHeader(token))
      .set(idem('on-account'))
      .send({ amount: 1000, method: 'cash' })
      .expect(201);

    assert.equal(res.body.bill, null);
    assert.equal(res.body.outstandingPayable, 5720);
  });
});

describe('cancelling a purchase', () => {
  it('takes the stock back out and reverses the ledger', async () => {
    const { business, token, vendor, product } = await setup();
    const bill = await createPurchase(token, billFor(vendor, product));
    assert.equal(await stockOf(product._id), 30);

    await api().post(`/api/v1/purchases/${bill._id}/cancel`).set(authHeader(token)).send({}).expect(200);

    assert.equal(await stockOf(product._id), 10);
    const entries = await ledgerFor(business._id, bill._id);
    assert.equal(entries.length, 4);
    const net = entries.reduce((sum, entry) => sum + (entry.direction === 'debit' ? entry.amount : -entry.amount), 0);
    assert.equal(net, 0);
    // Payable clears with it.
    assert.equal((await Vendor.findById(vendor._id).lean()).outstandingPayable, 0);
  });

  it('refuses to cancel a bill that has been paid', async () => {
    const { token, vendor, product } = await setup();
    const bill = await createPurchase(token, billFor(vendor, product));
    await api()
      .post(`/api/v1/purchases/vendors/${vendor._id}/payments`)
      .set(authHeader(token))
      .set(idem('pay'))
      .send({ amount: 500, billId: bill._id })
      .expect(201);

    const res = await api().post(`/api/v1/purchases/${bill._id}/cancel`).set(authHeader(token)).send({}).expect(409);

    assert.equal(res.body.details?.code || res.body.code, 'PURCHASE_HAS_PAYMENTS');
  });

  it('refuses to pay a cancelled bill and is idempotent on repeat cancel', async () => {
    const { token, vendor, product } = await setup();
    const bill = await createPurchase(token, billFor(vendor, product));

    await api().post(`/api/v1/purchases/${bill._id}/cancel`).set(authHeader(token)).send({}).expect(200);
    await api().post(`/api/v1/purchases/${bill._id}/cancel`).set(authHeader(token)).send({}).expect(200);

    await api()
      .post(`/api/v1/purchases/vendors/${vendor._id}/payments`)
      .set(authHeader(token))
      .set(idem('pay-cancelled'))
      .send({ amount: 100, billId: bill._id })
      .expect(409);
  });
});

describe('purchases in reports and isolation', () => {
  it('reports purchases and payables without subtracting them from profit', async () => {
    const { business, token, vendor, product } = await setup();
    const customer = await createCustomer(business);

    // Sell 2 at 500, cost 300 each => gross 400.
    await api()
      .post('/api/v1/invoices')
      .set(authHeader(token))
      .set(idem('invoice'))
      .send({ customerId: customer._id.toString(), items: [{ productId: product._id.toString(), quantity: 2, price: 500 }], taxRate: 0, discountValue: 0, allowOversell: true })
      .expect(201);

    await createPurchase(token, billFor(vendor, product));

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    assert.equal(report.profit.purchases, 6720);
    assert.equal(report.profit.payables, 6720);
    // Buying stock is not an expense — profit still comes from what actually sold.
    assert.equal(report.profit.grossProfit, 400);
    assert.equal(report.profit.netProfit, 400);
  });

  it('keeps a vendor payment out of collected revenue', async () => {
    const { business, token, vendor, product } = await setup();
    const bill = await createPurchase(token, billFor(vendor, product));

    await api()
      .post(`/api/v1/purchases/vendors/${vendor._id}/payments`)
      .set(authHeader(token))
      .set(idem('pay'))
      .send({ amount: 1000, method: 'cash', billId: bill._id })
      .expect(201);

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    // Money paid out must never read as money collected in.
    assert.equal(report.collected.today, 0);
    assert.equal(report.collected.range, 0);
    assert.equal(await Payment.countDocuments({ business: business._id, type: 'vendor_payment' }), 1);
  });

  it('never leaks vendors or bills across businesses', async () => {
    const mine = await createTestContext();
    const theirs = await setup();
    await createPurchase(theirs.token, billFor(theirs.vendor, theirs.product));

    const vendors = await api().get('/api/v1/purchases/vendors').set(authHeader(mine.token)).expect(200);
    const purchases = await api().get('/api/v1/purchases').set(authHeader(mine.token)).expect(200);

    assert.equal(vendors.body.vendors.length, 0);
    assert.equal(purchases.body.purchases.length, 0);
    await api().get(`/api/v1/purchases/vendors/${theirs.vendor._id}/outstanding`).set(authHeader(mine.token)).expect(404);
  });

  it('denies a staff member and lets a viewer read only', async () => {
    const staff = await createTestContext({ roleKey: 'staff' });
    const viewer = await createTestContext({ roleKey: 'viewer' });

    await api().get('/api/v1/purchases').set(authHeader(staff.token)).expect(403);
    await api().get('/api/v1/purchases').set(authHeader(viewer.token)).expect(200);
    await api().post('/api/v1/purchases').set(authHeader(viewer.token)).set(idem('deny')).send({ vendorId: '000000000000000000000000', items: [] }).expect(403);
  });
});
