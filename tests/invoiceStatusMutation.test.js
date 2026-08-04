import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import Payment from '../src/models/Payment.js';
import PaymentAllocation from '../src/models/PaymentAllocation.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext, invoicePayload } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

const createInvoice = async (token, customer, product) => {
  const res = await api()
    .post('/api/v1/invoices')
    .set(authHeader(token))
    .set(IDEMPOTENCY_HEADER, `inv-${Math.random().toString(36).slice(2, 10)}`)
    .send(invoicePayload({ customer, product, quantity: 1, allowOversell: true }))
    .expect(201);
  return res.body.invoice;
};

describe('invoice status mutation guard', () => {
  it('rejects paid status — payments must go through the payments API', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10 });
    const invoice = await createInvoice(token, customer, product);

    const res = await api()
      .patch(`/api/v1/invoices/${invoice._id}/status`)
      .set(authHeader(token))
      .send({ status: 'paid' })
      .expect(422);

    assert.equal(res.body.details?.code, 'PAYMENT_STATUS_VIA_PAYMENTS');
    assert.equal(await Payment.countDocuments({ business: business._id }), 0);
    assert.equal(await PaymentAllocation.countDocuments({ business: business._id }), 0);
  });

  it('rejects pending status that would wipe paidAmount without touching allocations', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10 });
    const invoice = await createInvoice(token, customer, product);

    const res = await api()
      .patch(`/api/v1/invoices/${invoice._id}/status`)
      .set(authHeader(token))
      .send({ status: 'pending' })
      .expect(422);

    assert.equal(res.body.details?.code, 'PAYMENT_STATUS_VIA_PAYMENTS');
  });

  it('still allows cancel via the status endpoint', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10 });
    const invoice = await createInvoice(token, customer, product);

    const res = await api()
      .patch(`/api/v1/invoices/${invoice._id}/status`)
      .set(authHeader(token))
      .send({ status: 'cancelled' })
      .expect(200);

    assert.equal(res.body.invoice.status, 'cancelled');
  });
});
