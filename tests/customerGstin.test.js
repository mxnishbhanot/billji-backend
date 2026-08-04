import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

// Valid GSTIN used elsewhere in the suite (Maharashtra).
const GSTIN = '27AAPFU0939F1ZV';

describe('customer GSTIN persistence', () => {
  it('stores gstNumber on create and update', async () => {
    const { token } = await createTestContext();

    const created = await api()
      .post('/api/v1/customers')
      .set(authHeader(token))
      .send({ name: 'Acme Traders', phone: '9876500001', gstNumber: GSTIN })
      .expect(201);

    assert.equal(created.body.customer.gstNumber, GSTIN);
    assert.equal(created.body.customer.taxIdentifiers?.gstNumber, GSTIN);

    const updated = await api()
      .patch(`/api/v1/customers/${created.body.customer._id}`)
      .set(authHeader(token))
      .send({ name: 'Acme Traders', phone: '9876500001', gstNumber: GSTIN, email: 'acme@example.com' })
      .expect(200);

    assert.equal(updated.body.customer.gstNumber, GSTIN);
    assert.equal(updated.body.customer.email, 'acme@example.com');
  });

  it('copies customer gstNumber onto the invoice snapshot used by GSTR-1', async () => {
    const { token } = await createTestContext();
    const productRes = await api()
      .post('/api/v1/products')
      .set(authHeader(token))
      .send({ name: 'Widget', price: 100, stockQuantity: 10 })
      .expect(201);

    const customer = await api()
      .post('/api/v1/customers')
      .set(authHeader(token))
      .send({ name: 'B2B Buyer', phone: '9876500002', gstNumber: GSTIN })
      .expect(201);

    const invoice = await api()
      .post('/api/v1/invoices')
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, `gstin-inv-${Date.now()}`)
      .send({
        customerId: customer.body.customer._id,
        items: [{ productId: productRes.body.product._id, quantity: 1, price: 100 }],
        taxRate: 18,
        allowOversell: true
      })
      .expect(201);

    assert.equal(invoice.body.invoice.customerSnapshot?.gstNumber, GSTIN);
  });
});
