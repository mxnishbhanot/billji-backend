import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

// Plain ₹1000 invoice: price 1000 x qty 1, no tax/discount.
const flatInvoicePayload = (customer, product) => ({
  customerId: customer._id.toString(),
  items: [{ productId: product._id.toString(), quantity: 1, price: 1000 }],
  taxRate: 0,
  discountType: 'flat',
  discountValue: 0,
  allowOversell: true
});

let invoiceSeq = 0;
const createInvoice = async (token, customer, product) => {
  invoiceSeq += 1;
  const res = await api()
    .post('/api/v1/invoices')
    .set(authHeader(token))
    .set(IDEMPOTENCY_HEADER, `inv-${invoiceSeq}-${Math.random().toString(36).slice(2, 8)}`)
    .send(flatInvoicePayload(customer, product))
    .expect(201);
  return res.body.invoice;
};

// An old ₹1000 invoice with a ₹500 partial payment already recorded (₹500 still due).
const setupCustomerWithDues = async () => {
  const { business, token } = await createTestContext();
  const customer = await createCustomer(business);
  const product = await createProduct(business, { stockQuantity: 1000, price: 1000 });

  const oldInvoice = await createInvoice(token, customer, product);
  await api()
    .post(`/api/v1/payments/invoices/${oldInvoice._id}/record`)
    .set(authHeader(token))
    .set(IDEMPOTENCY_HEADER, `old-pay-${oldInvoice._id}`)
    .send({ amount: 500, method: 'cash' })
    .expect(201);

  return { business, token, customer, product, oldInvoice };
};

const fetchInvoice = async (token, id) => (await api().get(`/api/v1/invoices/${id}`).set(authHeader(token)).expect(200)).body.invoice;

describe('customer payment allocation', () => {
  it('reports outstanding dues for a customer', async () => {
    const { token, customer } = await setupCustomerWithDues();
    const res = await api().get(`/api/v1/payments/customers/${customer._id}/outstanding`).set(authHeader(token)).expect(200);
    assert.equal(res.body.totalOutstanding, 500);
    assert.equal(res.body.invoices.length, 1);
    assert.equal(res.body.invoices[0].balanceDue, 500);
  });

  it('settles old due + new invoice fully when fully paid (₹1500)', async () => {
    const { token, customer, product, oldInvoice } = await setupCustomerWithDues();
    const newInvoice = await createInvoice(token, customer, product);

    const res = await api()
      .post(`/api/v1/payments/customers/${customer._id}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, `cust-pay-1500-${customer._id}`)
      .send({ amount: 1500, method: 'cash', invoiceIds: [oldInvoice._id, newInvoice._id] })
      .expect(201);

    assert.equal(res.body.payment.amount, 1500);
    assert.equal(res.body.payment.allocatedAmount, 1500);
    assert.equal(res.body.payment.unappliedAmount, 0);
    assert.equal(res.body.allocations.length, 2);

    const old = await fetchInvoice(token, oldInvoice._id);
    const fresh = await fetchInvoice(token, newInvoice._id);
    assert.equal(old.balanceDue, 0);
    assert.equal(old.paymentStatus, 'paid');
    assert.equal(fresh.total, 1000, 'new invoice total is untouched');
    assert.equal(fresh.balanceDue, 0);
    assert.equal(fresh.paymentStatus, 'paid');
  });

  it('leaves the new invoice partially due when underpaid (₹1300)', async () => {
    const { token, customer, product, oldInvoice } = await setupCustomerWithDues();
    const newInvoice = await createInvoice(token, customer, product);

    const res = await api()
      .post(`/api/v1/payments/customers/${customer._id}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, `cust-pay-1300-${customer._id}`)
      .send({ amount: 1300, method: 'cash', invoiceIds: [oldInvoice._id, newInvoice._id] })
      .expect(201);

    assert.equal(res.body.payment.unappliedAmount, 0);

    const old = await fetchInvoice(token, oldInvoice._id);
    const fresh = await fetchInvoice(token, newInvoice._id);
    assert.equal(old.balanceDue, 0, 'old due cleared first');
    assert.equal(fresh.balanceDue, 200, 'remainder left on the new invoice');
    assert.equal(fresh.paymentStatus, 'partial');
  });

  it('records overpayment as customer credit (₹1800)', async () => {
    const { token, customer, product, oldInvoice } = await setupCustomerWithDues();
    const newInvoice = await createInvoice(token, customer, product);

    const res = await api()
      .post(`/api/v1/payments/customers/${customer._id}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, `cust-pay-1800-${customer._id}`)
      .send({ amount: 1800, method: 'cash', invoiceIds: [oldInvoice._id, newInvoice._id] })
      .expect(201);

    assert.equal(res.body.payment.allocatedAmount, 1500);
    assert.equal(res.body.payment.unappliedAmount, 300);
    assert.equal(res.body.customerBalance.creditBalance, 300);
    assert.equal(res.body.customerBalance.outstandingDues, 0);

    const fresh = await fetchInvoice(token, newInvoice._id);
    assert.equal(fresh.balanceDue, 0);
    assert.equal(fresh.paymentStatus, 'paid');
  });

  it('lists a multi-invoice payment under each allocated invoice (payment history)', async () => {
    const { token, customer, product, oldInvoice } = await setupCustomerWithDues();
    const newInvoice = await createInvoice(token, customer, product);

    await api()
      .post(`/api/v1/payments/customers/${customer._id}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, `cust-pay-hist-${customer._id}`)
      .send({ amount: 1500, method: 'cash', invoiceIds: [oldInvoice._id, newInvoice._id] })
      .expect(201);

    // The payment's stored `invoice` is the last invoice, but it must still
    // appear in the OLD invoice's payment history via its allocation.
    const oldHistory = await api().get('/api/v1/payments').query({ invoiceId: oldInvoice._id }).set(authHeader(token)).expect(200);
    assert.ok(oldHistory.body.payments.some((p) => p.amount === 1500), 'multi-invoice payment shows under the old invoice');

    const newHistory = await api().get('/api/v1/payments').query({ invoiceId: newInvoice._id }).set(authHeader(token)).expect(200);
    assert.ok(newHistory.body.payments.some((p) => p.amount === 1500), 'multi-invoice payment shows under the new invoice');
  });

  it('rejects an overpayment when credit is not allowed (collect dues)', async () => {
    const { token, customer, oldInvoice } = await setupCustomerWithDues();

    // Old invoice has ₹500 due; collecting ₹800 with allowCredit:false must fail.
    await api()
      .post(`/api/v1/payments/customers/${customer._id}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, `cust-pay-over-${customer._id}`)
      .send({ amount: 800, method: 'cash', invoiceIds: [oldInvoice._id], allowCredit: false })
      .expect(422);
  });

  it('rejects an invoice that belongs to another customer', async () => {
    const { business, token, customer, product, oldInvoice } = await setupCustomerWithDues();
    const otherCustomer = await createCustomer(business, { name: 'Other', phone: '9000000000' });

    await api()
      .post(`/api/v1/payments/customers/${otherCustomer._id}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, `cust-pay-mismatch-${customer._id}`)
      .send({ amount: 500, method: 'cash', invoiceIds: [oldInvoice._id] })
      .expect(422);
  });
});
