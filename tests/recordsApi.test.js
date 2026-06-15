import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext, invoicePayload } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

describe('records read APIs (audit + ledger)', () => {
  it('lists audit logs for authorized members and blocks viewers', async () => {
    const { token } = await createTestContext();
    const res = await api().get('/api/v1/audit-logs').set(authHeader(token)).expect(200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.auditLogs));
    assert.ok(res.body.pagination);
    assert.equal(res.body.pagination.page, 1);

    const viewer = await createTestContext({ roleKey: 'viewer' });
    const forbidden = await api().get('/api/v1/audit-logs').set(authHeader(viewer.token)).expect(403);
    assert.equal(forbidden.body.details.code, 'FORBIDDEN_PERMISSION');
  });

  it('exposes ledger entries produced by a recorded payment', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);
    const product = await createProduct(business, { stockQuantity: 10, price: 100 });

    const invoiceResponse = await api()
      .post('/api/v1/invoices')
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, 'ledger-invoice')
      .send(invoicePayload({ customer, product, quantity: 2 }))
      .expect(201);
    const invoiceId = invoiceResponse.body.invoice._id;

    await api()
      .post(`/api/v1/payments/invoices/${invoiceId}/record`)
      .set(authHeader(token))
      .set(IDEMPOTENCY_HEADER, 'ledger-pay')
      .send({ amount: 100, method: 'cash' })
      .expect(201);

    const ledger = await api().get('/api/v1/ledger').set(authHeader(token)).expect(200);
    assert.equal(ledger.body.success, true);
    assert.ok(ledger.body.ledgerEntries.length >= 2, 'expected ledger entries from the recorded payment');
    assert.ok(ledger.body.pagination);
  });
});
