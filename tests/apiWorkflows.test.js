import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import CustomerBalance from '../src/models/CustomerBalance.js';
import IdempotencyKey from '../src/models/IdempotencyKey.js';
import Invoice from '../src/models/Invoice.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import Payment from '../src/models/Payment.js';
import PaymentAllocation from '../src/models/PaymentAllocation.js';
import Product from '../src/models/Product.js';
import StockMovement from '../src/models/StockMovement.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext, invoicePayload } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

const createInvoice = ({ token, customer, product, quantity = 2, key = 'invoice-key' }) =>
  api()
    .post('/api/v1/invoices')
    .set(authHeader(token))
    .set(IDEMPOTENCY_HEADER, key)
    .send(invoicePayload({ customer, product, quantity }));

describe('invoice API quality coverage', () => {
  it('creates an invoice transactionally, decrements stock, writes movement, and replays idempotent responses', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 5, price: 120 });

    const response = await createInvoice({ token, customer, product, quantity: 2, key: 'create-1' }).expect(201);
    assert.equal(response.body.success, true);
    assert.match(response.body.invoice.invoiceNumber, /^TST-\d{4}-\d{2}-0001$/);
    assert.equal(response.body.invoice.total, 283.2);

    const updatedProduct = await Product.findById(product._id).lean();
    assert.equal(updatedProduct.stockQuantity, 3);

    const movement = await StockMovement.findOne({ product: product._id }).lean();
    assert.equal(movement.quantityChange, -2);
    assert.equal(movement.stockBefore, 5);
    assert.equal(movement.stockAfter, 3);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await createInvoice({ token, customer, product, quantity: 2, key: 'create-1' }).expect(201);
    assert.equal(replay.body.invoice._id, response.body.invoice._id);
    assert.equal(await Invoice.countDocuments({ business: business._id }), 1);
  });

  it('cancels an unpaid invoice by restoring stock while preserving the invoice record', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 5, price: 120 });
    const invoiceResponse = await createInvoice({ token, customer, product, quantity: 2, key: 'cancel-unpaid' }).expect(201);
    const invoiceId = invoiceResponse.body.invoice._id;

    const cancelled = await api()
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set(authHeader(token))
      .send({ status: 'cancelled' })
      .expect(200);

    assert.equal(cancelled.body.invoice.status, 'cancelled');
    assert.ok(cancelled.body.invoice.cancelledAt);
    assert.equal(cancelled.body.invoice.paidAmount, 0);
    assert.equal((await Product.findById(product._id).lean()).stockQuantity, 5);
    assert.equal(await Invoice.countDocuments({ business: business._id }), 1);

    // A cancelled invoice is "processed" (it has stock movements) and is preserved
    // for audit — delete must be refused so the trail survives.
    const deleteAfterCancel = await api()
      .delete(`/api/v1/invoices/${invoiceId}`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, 'delete-after-cancel')
      .expect(409);
    assert.equal(deleteAfterCancel.body.details.code, 'INVOICE_NOT_DELETABLE');
    assert.equal(await Invoice.countDocuments({ business: business._id }), 1);
  });

  it('cancels a partially paid invoice: restores stock, reverses ledger, preserves payment as refund-pending, and still blocks delete', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 5, price: 120 });
    const invoiceResponse = await createInvoice({ token, customer, product, quantity: 2, key: 'paid-cancel-invoice' }).expect(201);
    const invoiceId = invoiceResponse.body.invoice._id;

    await api()
      .post(`/api/v1/payments/invoices/${invoiceId}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, 'paid-cancel-payment')
      .send({ amount: 100, method: 'cash' })
      .expect(201);

    const ledgerBefore = await LedgerEntry.countDocuments({ business: business._id, invoice: invoiceId });
    assert.ok(ledgerBefore > 0);

    // Cancel is allowed even with payments — it never auto-refunds.
    const cancelled = await api()
      .patch(`/api/v1/invoices/${invoiceId}/status`)
      .set(authHeader(token))
      .send({ status: 'cancelled', cancelReason: 'duplicate' })
      .expect(200);
    assert.equal(cancelled.body.invoice.status, 'cancelled');
    assert.equal(cancelled.body.invoice.cancelReason, 'duplicate');

    // Stock restored.
    assert.equal((await Product.findById(product._id).lean()).stockQuantity, 5);

    // Payment preserved and flagged refund-pending (not deleted, not refunded).
    const payments = await Payment.find({ business: business._id, invoice: invoiceId }).lean();
    assert.equal(payments.length, 1);
    assert.equal(payments[0].refundStatus, 'pending');

    // Compensating ledger entries posted; originals preserved.
    const reversals = await LedgerEntry.countDocuments({ business: business._id, invoice: invoiceId, sourceType: 'adjustment' });
    assert.equal(reversals, ledgerBefore);

    // Cancelled invoice still cannot be deleted.
    const deleteResponse = await api()
      .delete(`/api/v1/invoices/${invoiceId}`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, 'paid-cancel-delete')
      .expect(409);
    assert.equal(deleteResponse.body.details.code, 'INVOICE_NOT_DELETABLE');
    assert.equal(await Invoice.countDocuments({ business: business._id }), 1);
  });

  it('permanently deletes an unprocessed invoice (no payments, stock, or ledger)', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);

    // Custom line item only → no product, so no stock movements are written.
    const created = await api()
      .post('/api/v1/invoices')
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, 'deletable-invoice')
      .send({
        customerId: customer._id.toString(),
        items: [{ name: 'Consulting', quantity: 1, price: 500 }],
        taxRate: 0,
        discountType: 'flat',
        discountValue: 0,
        notes: 'service only'
      })
      .expect(201);
    const invoiceId = created.body.invoice._id;

    // Detail surfaces eligibility so the UI can enable the Delete button.
    const detail = await api().get(`/api/v1/invoices/${invoiceId}`).set(authHeader(token)).expect(200);
    assert.equal(detail.body.invoice.eligibility.canDelete, true);
    assert.equal(detail.body.invoice.eligibility.canCancel, true);

    assert.equal(await StockMovement.countDocuments({ business: business._id, invoice: invoiceId }), 0);

    await api().delete(`/api/v1/invoices/${invoiceId}`).set(authHeader(token)).set(IDEMPOTENCY_HEADER, 'deletable-delete').expect(200);
    assert.equal(await Invoice.countDocuments({ business: business._id }), 0);
  });

  it('rejects insufficient stock and rolls back invoice writes', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 1 });

    const response = await createInvoice({ token, customer, product, quantity: 2, key: 'insufficient-stock' }).expect(409);

    assert.equal(response.body.details.code, 'INSUFFICIENT_STOCK');
    assert.equal(await Invoice.countDocuments({ business: business._id }), 0);
    assert.equal(await StockMovement.countDocuments({ business: business._id }), 0);
    assert.equal((await Product.findById(product._id).lean()).stockQuantity, 1);
  });

  it('rejects reused idempotency keys with different request bodies', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10 });

    await createInvoice({ token, customer, product, quantity: 1, key: 'reused-key' }).expect(201);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = await createInvoice({ token, customer, product, quantity: 2, key: 'reused-key' }).expect(409);

    assert.equal(response.body.details.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await IdempotencyKey.countDocuments({ business: business._id, key: 'reused-key' }), 1);
  });

  it('enforces route permissions before protected financial mutations', async () => {
    const { business, token } = await createTestContext({ roleKey: 'viewer' });
    const customer = await createCustomer(business);
    const product = await createProduct(business);

    const response = await createInvoice({ token, customer, product, quantity: 1, key: 'viewer-create' }).expect(403);

    assert.equal(response.body.details.code, 'FORBIDDEN_PERMISSION');
    assert.equal(await Invoice.countDocuments({ business: business._id }), 0);
  });
});

describe('payment and draft quality coverage', () => {
  it('records partial payments with allocation, ledger entries, balance updates, and idempotent replay', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10, price: 100 });
    const invoiceResponse = await createInvoice({ token, customer, product, quantity: 2, key: 'payment-invoice' }).expect(201);
    const invoiceId = invoiceResponse.body.invoice._id;

    const paymentResponse = await api()
      .post(`/api/v1/payments/invoices/${invoiceId}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, 'payment-1')
      .send({ amount: 100, method: 'cash', reference: 'RCPT-1' });

    assert.equal(paymentResponse.status, 201, JSON.stringify(paymentResponse.body));

    assert.equal(paymentResponse.body.payment.amount, 100);
    assert.equal(paymentResponse.body.invoice.paymentStatus, 'partial');
    assert.equal(paymentResponse.body.invoice.paidAmount, 100);
    assert.equal(paymentResponse.body.invoice.balanceDue, 136);
    assert.equal(await PaymentAllocation.countDocuments({ invoice: invoiceId }), 1);
    assert.equal(await LedgerEntry.countDocuments({ invoice: invoiceId }), 2);
    assert.equal((await CustomerBalance.findOne({ customer: customer._id }).lean()).outstandingDues, 136);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await api()
      .post(`/api/v1/payments/invoices/${invoiceId}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, 'payment-1')
      .send({ amount: 100, method: 'cash', reference: 'RCPT-1' })
      .expect(201);

    assert.equal(replay.body.payment._id, paymentResponse.body.payment._id);
    assert.equal(await PaymentAllocation.countDocuments({ invoice: invoiceId }), 1);
  });

  it('supports draft upsert, list, and delete contracts', async () => {
    const { token } = await createTestContext();
    const payload = {
      documentType: 'invoice',
      schemaVersion: 1,
      payload: { selectedCustomerId: 'customer-1', items: [] },
      dirty: true,
      lastEditedAt: new Date().toISOString()
    };

    const upsert = await api().put('/api/v1/drafts/local-1').set(authHeader(token)).send(payload).expect(200);
    assert.equal(upsert.body.draft.localDraftId, 'local-1');
    assert.equal(upsert.body.draft.dirty, true);

    const list = await api().get('/api/v1/drafts').set(authHeader(token)).expect(200);
    assert.equal(list.body.drafts.length, 1);

    await api().delete('/api/v1/drafts/local-1').set(authHeader(token)).expect(200);
    const afterDelete = await api().get('/api/v1/drafts').set(authHeader(token)).expect(200);
    assert.equal(afterDelete.body.drafts.length, 0);
  });
});
