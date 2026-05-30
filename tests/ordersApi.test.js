import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Order from '../src/models/Order.js';
import Invoice from '../src/models/Invoice.js';
import Product from '../src/models/Product.js';
import StockMovement from '../src/models/StockMovement.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { processPendingOutboxEvents } from '../src/services/eventDispatcher.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

const orderPayload = ({ customer, product, quantity = 2 } = {}) => ({
  customerId: customer?._id?.toString(),
  items: [{ productId: product?._id?.toString(), quantity, price: product?.price ?? 100 }],
  taxRate: 18,
  discountType: 'flat',
  discountValue: 0,
  notes: 'Test order'
});

const createOrder = ({ token, customer, product, quantity = 2, key = 'order-key' }) =>
  api()
    .post('/api/v1/orders')
    .set(authHeader(token))
    .set(IDEMPOTENCY_HEADER, key)
    .send(orderPayload({ customer, product, quantity }));

describe('orders API (OR-1)', () => {
  it('creates an order with ORD numbering and totals, without touching stock', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 5, price: 120 });

    const response = await createOrder({ token, customer, product, quantity: 2, key: 'order-create-1' }).expect(201);
    assert.equal(response.body.success, true);
    assert.match(response.body.order.orderNumber, /^ORD-000001$/);
    assert.equal(response.body.order.total, 283.2);
    assert.equal(response.body.order.orderStatus, 'draft');
    assert.equal(response.body.order.paymentStatus, 'unpaid');
    assert.equal(response.body.order.paidAmount, 0);
    assert.equal(response.body.order.balanceDue, 283.2);

    // Orders never deduct stock or write movements (reservations deferred to OR-5).
    assert.equal((await Product.findById(product._id).lean()).stockQuantity, 5);
    assert.equal(await StockMovement.countDocuments({ business: business._id }), 0);
  });

  it('does not block ordering more than available stock', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 1 });

    await createOrder({ token, customer, product, quantity: 10, key: 'order-oversell' }).expect(201);
    assert.equal((await Product.findById(product._id).lean()).stockQuantity, 1);
  });

  it('increments ORD sequence across orders', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);

    const first = await createOrder({ token, customer, product, key: 'seq-1' }).expect(201);
    const second = await createOrder({ token, customer, product, key: 'seq-2' }).expect(201);
    assert.equal(first.body.order.orderNumber, 'ORD-000001');
    assert.equal(second.body.order.orderNumber, 'ORD-000002');
  });

  it('lists, filters by status/customer, and searches orders', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const other = await createCustomer(business, { name: 'Other Co', phone: '9000000000' });
    const product = await createProduct(business);

    const a = await createOrder({ token, customer, product, key: 'list-a' }).expect(201);
    await createOrder({ token, customer: other, product, key: 'list-b' }).expect(201);
    await api().post(`/api/v1/orders/${a.body.order._id}/cancel`).set(authHeader(token)).set(IDEMPOTENCY_HEADER, 'cancel-a').expect(200);

    const all = await api().get('/api/v1/orders').set(authHeader(token)).expect(200);
    assert.equal(all.body.orders.length, 2);

    const cancelled = await api().get('/api/v1/orders?orderStatus=cancelled').set(authHeader(token)).expect(200);
    assert.equal(cancelled.body.orders.length, 1);
    assert.equal(cancelled.body.orders[0]._id, a.body.order._id);

    const byCustomer = await api().get(`/api/v1/orders?customerId=${other._id}`).set(authHeader(token)).expect(200);
    assert.equal(byCustomer.body.orders.length, 1);

    const search = await api().get('/api/v1/orders?search=Other').set(authHeader(token)).expect(200);
    assert.equal(search.body.orders.length, 1);
  });

  it('reads a single order and 404s for unknown id', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);

    const created = await createOrder({ token, customer, product, key: 'get-1' }).expect(201);
    const got = await api().get(`/api/v1/orders/${created.body.order._id}`).set(authHeader(token)).expect(200);
    assert.equal(got.body.order.orderNumber, 'ORD-000001');

    await api().get('/api/v1/orders/64b7f0000000000000000000').set(authHeader(token)).expect(404);
  });

  it('cancels an order idempotently', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);

    const created = await createOrder({ token, customer, product, key: 'cancel-create' }).expect(201);
    const id = created.body.order._id;

    const cancelled = await api().post(`/api/v1/orders/${id}/cancel`).set(authHeader(token)).set(IDEMPOTENCY_HEADER, 'cancel-1').expect(200);
    assert.equal(cancelled.body.order.orderStatus, 'cancelled');
    assert.equal((await Order.findById(id).lean()).orderStatus, 'cancelled');
  });

  it('replays idempotent create without minting a second order', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business);

    const first = await createOrder({ token, customer, product, key: 'replay-1' }).expect(201);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await createOrder({ token, customer, product, key: 'replay-1' }).expect(201);

    assert.equal(replay.body.order._id, first.body.order._id);
    assert.equal(await Order.countDocuments({ business: business._id }), 1);
  });

  it('blocks order creation for viewers', async () => {
    const { business, token } = await createTestContext({ roleKey: 'viewer' });
    const customer = await createCustomer(business);
    const product = await createProduct(business);

    const response = await createOrder({ token, customer, product, key: 'viewer-order' }).expect(403);
    assert.equal(response.body.details.code, 'FORBIDDEN_PERMISSION');
    assert.equal(await Order.countDocuments({ business: business._id }), 0);
  });
});

const generateInvoice = ({ token, id, key = 'gen-key' }) =>
  api()
    .post(`/api/v1/orders/${id}/generate-invoice`)
    .set(authHeader(token))
    .set(IDEMPOTENCY_HEADER, key);

describe('orders generate-invoice (OR-2)', () => {
  it('generates one invoice from an order: totals, sourceOrder, stock deducted once, order confirmed', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 5, price: 120 });

    const created = await createOrder({ token, customer, product, quantity: 2, key: 'or2-create' }).expect(201);
    const orderId = created.body.order._id;

    const res = await generateInvoice({ token, id: orderId, key: 'or2-gen' }).expect(201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.invoice.total, 283.2);
    assert.equal(String(res.body.invoice.sourceOrder), String(orderId));
    assert.match(res.body.invoice.invoiceNumber, /^TST-/);

    // Stock deducts once at invoice time; exactly one 'sale' movement.
    assert.equal((await Product.findById(product._id).lean()).stockQuantity, 3);
    const movements = await StockMovement.find({ business: business._id }).lean();
    assert.equal(movements.length, 1);
    assert.equal(movements[0].type, 'sale');

    // Order flips draft -> confirmed.
    assert.equal((await Order.findById(orderId).lean()).orderStatus, 'confirmed');
  });

  it('blocks a second invoice from the same order (1->1 guard)', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10, price: 100 });

    const created = await createOrder({ token, customer, product, key: 'or2-dup-create' }).expect(201);
    const orderId = created.body.order._id;

    await generateInvoice({ token, id: orderId, key: 'or2-dup-1' }).expect(201);
    const second = await generateInvoice({ token, id: orderId, key: 'or2-dup-2' }).expect(409);
    assert.equal(second.body.details.code, 'ORDER_ALREADY_INVOICED');
    assert.equal(await Invoice.countDocuments({ business: business._id, sourceOrder: orderId }), 1);
  });

  it('idempotent generate: double-tap same key returns the same invoice and deducts stock once', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10, price: 100 });

    const created = await createOrder({ token, customer, product, quantity: 2, key: 'or2-idem-create' }).expect(201);
    const orderId = created.body.order._id;

    const first = await generateInvoice({ token, id: orderId, key: 'or2-idem' }).expect(201);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await generateInvoice({ token, id: orderId, key: 'or2-idem' }).expect(201);

    assert.equal(replay.body.invoice._id, first.body.invoice._id);
    assert.equal(await Invoice.countDocuments({ business: business._id }), 1);
    assert.equal((await Product.findById(product._id).lean()).stockQuantity, 8);
  });

  it('blocks cancelling an order once it has been invoiced', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10, price: 100 });

    const created = await createOrder({ token, customer, product, key: 'or2-cancel-create' }).expect(201);
    const orderId = created.body.order._id;

    await generateInvoice({ token, id: orderId, key: 'or2-cancel-gen' }).expect(201);
    const cancelRes = await api()
      .post(`/api/v1/orders/${orderId}/cancel`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, 'or2-cancel-blocked')
      .expect(409);
    assert.equal(cancelRes.body.details.code, 'ORDER_ALREADY_INVOICED_CANNOT_CANCEL');
    assert.equal((await Order.findById(orderId).lean()).orderStatus, 'confirmed');
  });

  it('refuses to invoice a cancelled order', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10, price: 100 });

    const created = await createOrder({ token, customer, product, key: 'or2-cancelled-create' }).expect(201);
    const orderId = created.body.order._id;

    await api().post(`/api/v1/orders/${orderId}/cancel`).set(authHeader(token)).set(IDEMPOTENCY_HEADER, 'or2-pre-cancel').expect(200);
    const res = await generateInvoice({ token, id: orderId, key: 'or2-on-cancelled' }).expect(409);
    assert.equal(res.body.details.code, 'ORDER_CANCELLED');
    assert.equal(await Invoice.countDocuments({ business: business._id }), 0);
  });

  it('blocks generate-invoice for staff (no orders.manage)', async () => {
    const { business, token } = await createTestContext({ roleKey: 'staff' });
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 5, price: 100 });

    const created = await createOrder({ token, customer, product, key: 'or2-staff-create' }).expect(201);
    const res = await generateInvoice({ token, id: created.body.order._id, key: 'or2-staff-gen' }).expect(403);
    assert.equal(res.body.details.code, 'FORBIDDEN_PERMISSION');
  });
});

const recordPayment = ({ token, invoiceId, amount, key }) =>
  api()
    .post(`/api/v1/payments/invoices/${invoiceId}/record`)
    .set(authHeader(token))
    .set(IDEMPOTENCY_HEADER, key)
    .send({ amount, method: 'cash' });

const getOrderDetail = ({ token, id }) => api().get(`/api/v1/orders/${id}`).set(authHeader(token));

// price 100 x qty 2 = 200 subtotal, +18% tax = 236 total.
const seedInvoicedOrder = async ({ token, business }) => {
  const customer = await createCustomer(business);
  const product = await createProduct(business, { stockQuantity: 50, price: 100 });
  const created = await createOrder({ token, customer, product, quantity: 2, key: `or3-create-${product._id}` }).expect(201);
  const orderId = created.body.order._id;
  const gen = await generateInvoice({ token, id: orderId, key: `or3-gen-${orderId}` }).expect(201);
  return { orderId, invoiceId: gen.body.invoice._id, total: gen.body.invoice.total };
};

describe('orders derived payment status (OR-3)', () => {
  it('order with no invoice reports unpaid with full balance from order total', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10, price: 100 });

    const created = await createOrder({ token, customer, product, quantity: 2, key: 'or3-noinv' }).expect(201);
    const detail = await getOrderDetail({ token, id: created.body.order._id }).expect(200);

    assert.equal(detail.body.order.paymentStatus, 'unpaid');
    assert.equal(detail.body.order.paidAmount, 0);
    assert.equal(detail.body.order.balanceDue, 236);
    assert.equal(detail.body.order.invoiceCount, 0);
  });

  it('derives unpaid -> partial when a partial payment is recorded on the invoice', async () => {
    const { business, token } = await createTestContext();
    const { orderId, invoiceId } = await seedInvoicedOrder({ token, business });

    await recordPayment({ token, invoiceId, amount: 100, key: 'or3-partial-pay' }).expect(201);

    const detail = await getOrderDetail({ token, id: orderId }).expect(200);
    assert.equal(detail.body.order.paymentStatus, 'partial');
    assert.equal(detail.body.order.paidAmount, 100);
    assert.equal(detail.body.order.balanceDue, 136);
    // Detail exposes the linked invoice so the client can deep-link Order -> Invoice.
    assert.equal(String(detail.body.order.linkedInvoice.id), String(invoiceId));
    assert.match(detail.body.order.linkedInvoice.invoiceNumber, /^TST-/);
  });

  it('derives partial -> paid when the balance is settled', async () => {
    const { business, token } = await createTestContext();
    const { orderId, invoiceId } = await seedInvoicedOrder({ token, business });

    await recordPayment({ token, invoiceId, amount: 100, key: 'or3-p2p-1' }).expect(201);
    await recordPayment({ token, invoiceId, amount: 136, key: 'or3-p2p-2' }).expect(201);

    const detail = await getOrderDetail({ token, id: orderId }).expect(200);
    assert.equal(detail.body.order.paymentStatus, 'paid');
    assert.equal(detail.body.order.paidAmount, 236);
    assert.equal(detail.body.order.balanceDue, 0);
  });

  it('aggregates multiple payments on one invoice', async () => {
    const { business, token } = await createTestContext();
    const { orderId, invoiceId } = await seedInvoicedOrder({ token, business });

    await recordPayment({ token, invoiceId, amount: 50, key: 'or3-multi-1' }).expect(201);
    await recordPayment({ token, invoiceId, amount: 50, key: 'or3-multi-2' }).expect(201);
    await recordPayment({ token, invoiceId, amount: 136, key: 'or3-multi-3' }).expect(201);

    const detail = await getOrderDetail({ token, id: orderId }).expect(200);
    assert.equal(detail.body.order.paidAmount, 236);
    assert.equal(detail.body.order.paymentStatus, 'paid');
  });

  it('writes the cached order fields via the outbox dispatcher on payment.recorded', async () => {
    const { business, token } = await createTestContext();
    const { orderId, invoiceId } = await seedInvoicedOrder({ token, business });

    await recordPayment({ token, invoiceId, amount: 236, key: 'or3-cache-pay' }).expect(201);
    await processPendingOutboxEvents();

    // Read the raw persisted doc (no live derivation) to prove the cache was written.
    const cached = await Order.findById(orderId).lean();
    assert.equal(cached.paymentStatus, 'paid');
    assert.equal(cached.paidAmount, 236);
    assert.equal(cached.balanceDue, 0);
  });

  it('recomputes the order cache when the linked invoice is cancelled/deleted', async () => {
    const { business, token } = await createTestContext();
    const { orderId, invoiceId } = await seedInvoicedOrder({ token, business });

    await recordPayment({ token, invoiceId, amount: 236, key: 'or3-void-pay' }).expect(201);
    await processPendingOutboxEvents();
    assert.equal((await Order.findById(orderId).lean()).paymentStatus, 'paid');

    // Cancelling the invoice (hard delete) reverses the financial link.
    await api().delete(`/api/v1/invoices/${invoiceId}`).set(authHeader(token)).set(IDEMPOTENCY_HEADER, 'or3-void-del').expect(200);
    await processPendingOutboxEvents();

    const cached = await Order.findById(orderId).lean();
    assert.equal(cached.paymentStatus, 'unpaid');
    assert.equal(cached.paidAmount, 0);
    assert.equal(cached.balanceDue, 236);

    // Detail view agrees (no live invoice).
    const detail = await getOrderDetail({ token, id: orderId }).expect(200);
    assert.equal(detail.body.order.invoiceCount, 0);
    assert.equal(detail.body.order.paymentStatus, 'unpaid');
  });
});
