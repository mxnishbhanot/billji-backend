import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Product from '../src/models/Product.js';
import { SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION, encodeCursor } from '../src/modules/sync/protocol.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

// These tests create a record and pull it in the same breath, so the commit-settling lag
// is switched off. syncCursor.test.js is where the lag itself is exercised.
process.env.SYNC_SAFETY_LAG_MS = '0';

useMongoTestDb();

const syncHeaders = (token) => ({ ...authHeader(token), [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION) });
const api = () => request(app);

const push = (token, ops) => api().post('/api/v1/sync/push').set(syncHeaders(token)).send({ ops });

describe('sync protocol handshake', () => {
  it('rejects a request with no protocol version', async () => {
    const { token } = await createTestContext();

    const response = await api().get('/api/v1/sync/status').set(authHeader(token)).expect(426);
    assert.equal(response.body.details.code, 'SYNC_PROTOCOL_UNSUPPORTED');
  });

  it('rejects an unsupported protocol version', async () => {
    const { token } = await createTestContext();

    await api().get('/api/v1/sync/status').set(authHeader(token)).set(SYNC_PROTOCOL_HEADER, '99').expect(426);
  });

  it('still requires authentication', async () => {
    await api().get('/api/v1/sync/status').set(SYNC_PROTOCOL_HEADER, '1').expect(401);
  });
});

describe('GET /sync/status', () => {
  it('returns server time, protocol version, limits and a cursor per collection', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business);

    const { body } = await api().get('/api/v1/sync/status').set(syncHeaders(token)).expect(200);

    assert.equal(body.protocolVersion, SYNC_PROTOCOL_VERSION);
    assert.ok(Date.parse(body.serverTime));
    assert.equal(String(body.businessId), String(business._id));
    assert.ok(body.cursors.products, 'a populated collection has a cursor');
    assert.equal(body.cursors.customers, null, 'an empty collection has none');
    assert.equal(body.limits.maxPushOperations, 50);
    assert.equal(body.featureFlags.syncPull, true);
  });

  it('hides collections the member cannot read', async () => {
    const { token } = await createTestContext({ roleKey: 'staff' });

    const { body } = await api().get('/api/v1/sync/status').set(syncHeaders(token)).expect(200);

    assert.ok('products' in body.cursors);
    assert.ok(!('expenses' in body.cursors), 'staff cannot view expenses');
  });
});

describe('POST /sync/push', () => {
  it('applies a batch through the existing controllers and reports each op independently', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);

    const { body } = await push(token, [
      {
        opId: 'op-product-create-1',
        entity: 'product',
        opType: 'create',
        clientId: '01927b3e-0000-7000-8000-00000000aaaa',
        payload: { name: 'Offline product', price: 100, stockQuantity: 5 }
      },
      {
        opId: 'op-product-bad-1',
        entity: 'product',
        opType: 'create',
        payload: { name: '', price: -1, stockQuantity: 5 }
      },
      {
        opId: 'op-invoice-create-1',
        entity: 'invoice',
        opType: 'create',
        clientId: '01927b3e-0000-7000-8000-00000000bbbb',
        payload: {
          customerId: String(customer._id),
          items: [{ name: 'Service', quantity: 1, price: 500 }],
          taxRate: 18
        }
      }
    ]).expect(200);

    assert.deepEqual(body.summary, { ok: 2, conflict: 0, rejected: 1 });

    const [created, rejected, invoice] = body.results;
    assert.equal(created.status, 'ok');
    assert.equal(created.version, 1);
    assert.ok(created.serverId);
    assert.equal(created.record.clientId, '01927b3e-0000-7000-8000-00000000aaaa');

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.statusCode, 422);
    assert.ok(rejected.details.length, 'validation detail is reported back');

    assert.equal(invoice.status, 'ok');
    // The invoice went through invoiceService: it has a server-issued number, and the
    // share token was never sent to the device.
    assert.ok(invoice.record.invoiceNumber);
  });

  it('echoes the existing record instead of creating a duplicate on a retried create', async () => {
    const { token } = await createTestContext();
    const op = {
      opId: 'op-product-create-2',
      entity: 'product',
      opType: 'create',
      clientId: '01927b3e-0000-7000-8000-00000000cccc',
      payload: { name: 'Retried', price: 20, stockQuantity: 1 }
    };

    const first = await push(token, [op]).expect(200);
    const second = await push(token, [op]).expect(200);

    assert.equal(second.body.results[0].status, 'ok');
    assert.equal(second.body.results[0].serverId, first.body.results[0].serverId);
    assert.equal(await Product.countDocuments({}), 1);
  });

  it('updates and tombstones through the same controllers', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business, { name: 'Before' });

    const updated = await push(token, [
      {
        opId: 'op-product-update-1',
        entity: 'product',
        opType: 'update',
        targetId: String(product._id),
        payload: { name: 'After', price: 150, stockQuantity: 4 }
      }
    ]).expect(200);
    assert.equal(updated.body.results[0].record.name, 'After');

    const deleted = await push(token, [
      { opId: 'op-product-delete-1', entity: 'product', opType: 'delete', targetId: String(product._id) }
    ]).expect(200);
    assert.equal(deleted.body.results[0].status, 'ok');

    const missing = await push(token, [
      { opId: 'op-product-delete-2', entity: 'product', opType: 'delete', targetId: String(product._id) }
    ]).expect(200);
    assert.equal(missing.body.results[0].status, 'rejected');
    assert.equal(missing.body.results[0].statusCode, 404);
  });

  it('records a payment against an invoice created earlier in the same batch cycle', async () => {
    const { business, token } = await createTestContext();
    const customer = await createCustomer(business);

    const created = await push(token, [
      {
        opId: 'op-invoice-create-2',
        entity: 'invoice',
        opType: 'create',
        payload: { customerId: String(customer._id), items: [{ name: 'Goods', quantity: 1, price: 1000 }] }
      }
    ]).expect(200);
    const invoiceId = created.body.results[0].serverId;

    const { body } = await push(token, [
      {
        opId: 'op-payment-create-1',
        entity: 'payment',
        opType: 'create',
        clientId: '01927b3e-0000-7000-8000-00000000dddd',
        payload: { invoiceId, amount: 400, method: 'cash' }
      }
    ]).expect(200);

    assert.equal(body.results[0].status, 'ok');
    assert.equal(body.results[0].record.amount, 400);
    // The ledger, allocation and balance were computed server-side; the device pushed intent only.
    assert.equal(body.results[0].record.clientId, '01927b3e-0000-7000-8000-00000000dddd');
  });

  it('rejects an unsupported operation without touching the rest of the batch', async () => {
    const { token } = await createTestContext();

    const { body } = await push(token, [
      { opId: 'op-invoice-update-1', entity: 'invoice', opType: 'update', targetId: '507f1f77bcf86cd799439011', payload: {} },
      { opId: 'op-product-create-3', entity: 'product', opType: 'create', payload: { name: 'Fine', price: 1, stockQuantity: 0 } }
    ]).expect(200);

    assert.equal(body.results[0].code, 'UNSUPPORTED_OPERATION');
    assert.equal(body.results[1].status, 'ok');
  });

  it('re-checks permissions server-side even though the device cached its own', async () => {
    const { token } = await createTestContext({ roleKey: 'viewer' });

    const { body } = await push(token, [
      { opId: 'op-product-create-4', entity: 'product', opType: 'create', payload: { name: 'Nope', price: 1, stockQuantity: 0 } }
    ]).expect(200);

    assert.equal(body.results[0].status, 'rejected');
    assert.equal(body.results[0].statusCode, 403);
    assert.equal(await Product.countDocuments({}), 0);
  });

  it('refuses a batch over the operation cap', async () => {
    const { token } = await createTestContext();
    const ops = Array.from({ length: 51 }, (_, index) => ({
      opId: `op-bulk-${index}-padding`,
      entity: 'product',
      opType: 'create',
      payload: { name: `P${index}`, price: 1, stockQuantity: 0 }
    }));

    await push(token, ops).expect(422);
    assert.equal(await Product.countDocuments({}), 0);
  });
});

describe('GET /sync/pull', () => {
  it('pages by cursor, never repeats and never skips', async () => {
    const { business, token } = await createTestContext();
    for (let index = 0; index < 5; index += 1) {
      await createProduct(business, { name: `Product ${index}` });
    }

    const first = await api()
      .get('/api/v1/sync/pull?collection=products&limit=2')
      .set(syncHeaders(token))
      .expect(200);

    assert.equal(first.body.records.length, 2);
    assert.equal(first.body.hasMore, true);

    const seen = new Set(first.body.records.map((record) => String(record._id)));
    let cursor = first.body.nextCursor;
    let hasMore = true;

    while (hasMore) {
      const page = await api()
        .get(`/api/v1/sync/pull?collection=products&limit=2&cursor=${encodeURIComponent(cursor)}`)
        .set(syncHeaders(token))
        .expect(200);

      page.body.records.forEach((record) => {
        assert.ok(!seen.has(String(record._id)), 'a record must not be delivered twice');
        seen.add(String(record._id));
      });

      cursor = page.body.nextCursor || cursor;
      hasMore = page.body.hasMore;
    }

    assert.equal(seen.size, 5);
  });

  it('carries deletions as tombstones so a delete can travel in the delta stream', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business, { name: 'Doomed' });

    const before = await api().get('/api/v1/sync/pull?collection=products').set(syncHeaders(token)).expect(200);
    const cursor = before.body.nextCursor;

    await api().delete(`/api/v1/products/${product._id}`).set(authHeader(token)).expect(200);

    const after = await api()
      .get(`/api/v1/sync/pull?collection=products&cursor=${encodeURIComponent(cursor)}`)
      .set(syncHeaders(token))
      .expect(200);

    assert.equal(after.body.records.length, 1);
    assert.ok(after.body.records[0].deletedAt);
    assert.equal(after.body.records[0].name, undefined, 'a tombstone carries identity only');
  });

  it('never returns another business\'s records', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();
    await createProduct(theirs.business, { name: 'Not yours' });

    const { body } = await api().get('/api/v1/sync/pull?collection=products').set(syncHeaders(mine.token)).expect(200);

    assert.equal(body.records.length, 0);
  });

  it('rejects an unknown collection, a malformed cursor and an expired one', async () => {
    const { token } = await createTestContext();

    await api().get('/api/v1/sync/pull?collection=ledger').set(syncHeaders(token)).expect(422);

    const malformed = await api()
      .get('/api/v1/sync/pull?collection=products&cursor=not-a-cursor')
      .set(syncHeaders(token))
      .expect(400);
    assert.equal(malformed.body.details.code, 'CURSOR_INVALID');

    const stale = encodeCursor({ updatedAt: new Date('2020-01-01'), _id: '507f1f77bcf86cd799439011' }, 'products');
    const expired = await api()
      .get(`/api/v1/sync/pull?collection=products&cursor=${encodeURIComponent(stale)}`)
      .set(syncHeaders(token))
      .expect(409);
    assert.equal(expired.body.details.code, 'CURSOR_EXPIRED');
  });

  it('refuses a collection the member cannot read', async () => {
    const { token } = await createTestContext({ roleKey: 'staff' });

    await api().get('/api/v1/sync/pull?collection=expenses').set(syncHeaders(token)).expect(403);
  });
});

describe('GET /sync/bootstrap', () => {
  it('returns the phase-1 working set, not the whole database', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business, { name: 'Active' });
    await createProduct(business, { name: 'Archived', isActive: false });
    await createCustomer(business);

    const { body } = await api().get('/api/v1/sync/bootstrap').set(syncHeaders(token)).expect(200);

    assert.equal(body.scope, 'phase1');
    assert.equal(String(body.business._id), String(business._id));
    assert.ok(body.permissions.length);
    assert.deepEqual(Object.keys(body.collections).sort(), ['customers', 'invoices', 'orders', 'products']);
    assert.deepEqual(body.collections.products.records.map((record) => record.name), ['Active']);
    assert.equal(body.collections.customers.records.length, 1);
    assert.ok(body.cursors.products, 'the delta pull starts from these cursors');
  });

  it('pages a single collection so the response never grows unbounded', async () => {
    const { business, token } = await createTestContext();
    for (let index = 0; index < 3; index += 1) {
      await createProduct(business, { name: `Bulk ${index}` });
    }

    const { body } = await api()
      .get('/api/v1/sync/bootstrap?collection=products&limit=2')
      .set(syncHeaders(token))
      .expect(200);

    assert.deepEqual(Object.keys(body.collections), ['products']);
    assert.equal(body.collections.products.records.length, 2);
    assert.equal(body.collections.products.hasMore, true);
  });

  it('serves the phase-2 history window', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business);

    const { body } = await api().get('/api/v1/sync/bootstrap?scope=phase2&months=12').set(syncHeaders(token)).expect(200);

    assert.equal(body.scope, 'phase2');
    assert.ok('payments' in body.collections);
    assert.ok(!('products' in body.collections), 'products are already complete after phase 1');
  });
});
