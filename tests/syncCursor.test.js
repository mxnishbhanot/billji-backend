import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Product from '../src/models/Product.js';
import { SYNC_PROTOCOL_HEADER, encodeCursor } from '../src/modules/sync/protocol.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createProduct, createTestContext } from './helpers/fixtures.js';

process.env.SYNC_SAFETY_LAG_MS = '0';

useMongoTestDb();

const api = () => request(app);
const syncHeaders = (token) => ({ ...authHeader(token), [SYNC_PROTOCOL_HEADER]: '1' });

const pull = (token, query) => api().get(`/api/v1/sync/pull?${query}`).set(syncHeaders(token));

// Drains a collection one page at a time and returns every id in delivery order.
const drain = async (token, collection, limit) => {
  const delivered = [];
  let cursor = '';
  let hasMore = true;
  let pages = 0;

  while (hasMore) {
    const query = `collection=${collection}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { body } = await pull(token, query).expect(200);

    delivered.push(...body.records.map((record) => String(record._id)));
    cursor = body.nextCursor;
    hasMore = body.hasMore;
    pages += 1;

    assert.ok(pages < 50, 'the cursor must terminate, not loop');
  }

  return delivered;
};

describe('composite cursor: (updatedAt, _id)', () => {
  it('delivers every record exactly once when timestamps collide', async () => {
    const { business, token } = await createTestContext();
    for (let index = 0; index < 6; index += 1) {
      await createProduct(business, { name: `Imported ${index}` });
    }

    // The bulk-import case: one `updatedAt` shared by the whole batch. A timestamp-only
    // cursor either skips the tail of this page or serves it forever.
    const sharedTimestamp = new Date('2026-07-01T10:00:00.000Z');
    await Product.collection.updateMany({}, { $set: { updatedAt: sharedTimestamp } });

    const delivered = await drain(token, 'products', 2);
    const ids = await Product.find({}).select('_id').lean();

    assert.equal(delivered.length, 6, 'no record delivered twice');
    assert.deepEqual(new Set(delivered).size, 6, 'no record skipped');
    assert.deepEqual(
      [...delivered].sort(),
      ids.map((row) => String(row._id)).sort()
    );
    // _id is the tiebreaker, so a page boundary inside one timestamp is still a total order.
    assert.deepEqual(delivered, [...delivered].sort());
  });

  it('resumes from a page boundary rather than counting rows', async () => {
    const { business, token } = await createTestContext();
    for (let index = 0; index < 5; index += 1) {
      await createProduct(business, { name: `Product ${index}` });
    }

    const byOne = await drain(token, 'products', 1);
    const byFive = await drain(token, 'products', 5);

    // Page size changes how many round trips it takes, never what arrives or in what order.
    assert.deepEqual(byOne, byFive);
  });

  it('sees a record again when it is edited after the cursor passed it', async () => {
    const { business, token } = await createTestContext();
    const product = await createProduct(business, { name: 'Original' });
    await createProduct(business, { name: 'Other' });

    const first = await pull(token, 'collection=products').expect(200);
    assert.equal(first.body.records.length, 2);

    await Product.findOneAndUpdate({ _id: product._id }, { $set: { name: 'Edited' } });

    const second = await pull(token, `collection=products&cursor=${encodeURIComponent(first.body.nextCursor)}`).expect(200);
    assert.deepEqual(second.body.records.map((record) => record.name), ['Edited']);
  });
});

describe('cursor validation', () => {
  it('refuses a cursor minted for a different collection', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business);

    const { body } = await pull(token, 'collection=products').expect(200);
    const response = await pull(token, `collection=customers&cursor=${encodeURIComponent(body.nextCursor)}`).expect(400);

    assert.equal(response.body.details.code, 'CURSOR_COLLECTION_MISMATCH');
    assert.equal(response.body.details.cursorCollection, 'products');
  });

  it('refuses a future-dated cursor instead of skipping everything up to it', async () => {
    const { token } = await createTestContext();
    const future = encodeCursor(
      { updatedAt: new Date(Date.now() + 60 * 60 * 1000), _id: '507f1f77bcf86cd799439011' },
      'products'
    );

    const response = await pull(token, `collection=products&cursor=${encodeURIComponent(future)}`).expect(400);
    assert.equal(response.body.details.code, 'CURSOR_INVALID');
  });

  it('refuses a cursor from an older wire format', async () => {
    const { token } = await createTestContext();
    const legacy = Buffer.from(`${new Date().toISOString()}|507f1f77bcf86cd799439011`).toString('base64url');

    const response = await pull(token, `collection=products&cursor=${encodeURIComponent(legacy)}`).expect(400);
    assert.equal(response.body.details.code, 'CURSOR_INVALID');
  });

  it('expires a cursor older than the tombstone retention window', async () => {
    const { token } = await createTestContext();
    const ancient = encodeCursor({ updatedAt: new Date('2020-01-01'), _id: '507f1f77bcf86cd799439011' }, 'products');

    const response = await pull(token, `collection=products&cursor=${encodeURIComponent(ancient)}`).expect(409);
    assert.equal(response.body.details.code, 'CURSOR_EXPIRED');
    assert.equal(response.body.details.tombstoneRetentionDays, 90);
  });

  it('hands an empty page its own cursor back, not a reset', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business);

    const first = await pull(token, 'collection=products').expect(200);
    const second = await pull(token, `collection=products&cursor=${encodeURIComponent(first.body.nextCursor)}`).expect(200);

    assert.equal(second.body.records.length, 0);
    assert.equal(second.body.hasMore, false);
    assert.equal(second.body.nextCursor, first.body.nextCursor, 'an idle pull must not trigger a full re-sync');
  });

  it('requires a collection alongside a bootstrap cursor', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business);

    const { body } = await pull(token, 'collection=products').expect(200);
    const response = await api()
      .get(`/api/v1/sync/bootstrap?cursor=${encodeURIComponent(body.nextCursor)}`)
      .set(syncHeaders(token))
      .expect(400);

    assert.equal(response.body.details.code, 'CURSOR_COLLECTION_REQUIRED');
  });
});

describe('commit-settling horizon', () => {
  it('withholds writes newer than the safety lag, then delivers them', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business, { name: 'Just written' });

    process.env.SYNC_SAFETY_LAG_MS = '60000';
    try {
      const withheld = await pull(token, 'collection=products').expect(200);
      assert.equal(withheld.body.records.length, 0, 'a record that may still be committing is held back');
      assert.equal(withheld.body.nextCursor, null);

      const status = await api().get('/api/v1/sync/status').set(syncHeaders(token)).expect(200);
      assert.equal(status.body.cursors.products, null, 'the starting cursor never runs ahead of the horizon');
    } finally {
      process.env.SYNC_SAFETY_LAG_MS = '0';
    }

    const delivered = await pull(token, 'collection=products').expect(200);
    assert.deepEqual(delivered.body.records.map((record) => record.name), ['Just written']);
  });
});
