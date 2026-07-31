import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext, invoicePayload } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

describe('invoice list customerId filter', () => {
  it('returns only that customer\'s invoices, newest first', async () => {
    const { business, token } = await createTestContext();
    const mine = await createCustomer(business, { name: 'Repeat Buyer', phone: '9000000001' });
    const other = await createCustomer(business, { name: 'Someone Else', phone: '9000000002' });
    const product = await createProduct(business, { stockQuantity: 50, price: 100 });

    for (const [index, customer] of [mine, other, mine].entries()) {
      await api()
        .post('/api/v1/invoices')
        .set(authHeader(token))
        .set(IDEMPOTENCY_HEADER, `filter-invoice-${index}`)
        .send(invoicePayload({ customer, product, quantity: index + 1 }))
        .expect(201);
    }

    const res = await api()
      .get('/api/v1/invoices')
      .query({ customerId: String(mine._id), sort: 'newest', limit: 1, paginated: true })
      .set(authHeader(token))
      .expect(200);

    assert.equal(res.body.invoices.length, 1);
    assert.equal(res.body.pagination.total, 2, 'only the two invoices for this customer');
    // Newest first: the last invoice created for `mine` had quantity 3.
    assert.equal(res.body.invoices[0].items[0].quantity, 3);

    const bad = await api().get('/api/v1/invoices').query({ customerId: 'not-an-id' }).set(authHeader(token)).expect(422);
    assert.equal(bad.body.success, false);
  });
});
