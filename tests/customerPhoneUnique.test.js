import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

describe('customer phone uniqueness', () => {
  it('rejects a second customer with the same phone', async () => {
    const { business, token } = await createTestContext();
    await createCustomer(business, { name: 'Ravi', phone: '9876543210' });

    const res = await api()
      .post('/api/v1/customers')
      .set(authHeader(token))
      .send({ name: 'Ravi Again', phone: '9876543210' })
      .expect(409);

    assert.equal(res.body.details?.code, 'CUSTOMER_PHONE_EXISTS');
  });

  it('rejects the same phone typed with country-code formatting', async () => {
    const { business, token } = await createTestContext();
    await createCustomer(business, { name: 'Ravi', phone: '9876543210' });

    const res = await api()
      .post('/api/v1/customers')
      .set(authHeader(token))
      .send({ name: 'Ravi Formatted', phone: '+91 98765 43210' })
      .expect(409);

    assert.equal(res.body.details?.code, 'CUSTOMER_PHONE_EXISTS');
  });

  it('allows updating a customer without changing phone', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business, { name: 'Ravi', phone: '9876543210' });

    const res = await api()
      .patch(`/api/v1/customers/${customer._id}`)
      .set(authHeader(token))
      .send({ name: 'Ravi Traders', phone: '9876543210', email: 'ravi@example.com' })
      .expect(200);

    assert.equal(res.body.customer.name, 'Ravi Traders');
  });

  it('rejects updating onto another customer phone', async () => {
    const { business, token } = await createTestContext();
    await createCustomer(business, { name: 'Ravi', phone: '9876543210' });
    const other = await createCustomer(business, { name: 'Sunita', phone: '9000011111' });

    const res = await api()
      .patch(`/api/v1/customers/${other._id}`)
      .set(authHeader(token))
      .send({ name: 'Sunita', phone: '9876543210' })
      .expect(409);

    assert.equal(res.body.details?.code, 'CUSTOMER_PHONE_EXISTS');
  });

  it('allows reusing a phone after soft-delete', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business, { name: 'Gone', phone: '9111122222' });

    await api().delete(`/api/v1/customers/${customer._id}`).set(authHeader(token)).expect(200);

    const res = await api()
      .post('/api/v1/customers')
      .set(authHeader(token))
      .send({ name: 'Back', phone: '9111122222' })
      .expect(201);

    assert.equal(res.body.customer.phone, '9111122222');
  });
});
