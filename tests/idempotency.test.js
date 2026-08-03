import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import IdempotencyKey from '../src/models/IdempotencyKey.js';
import Product from '../src/models/Product.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);
const payload = { name: 'Idempotent product', price: 50, stockQuantity: 5 };

const createProductRequest = (token, key, body = payload) =>
  api().post('/api/v1/products').set(authHeader(token)).set('Idempotency-Key', key).send(body);

describe('idempotency: replay', () => {
  it('replays the stored response and writes only once', async () => {
    const { token } = await createTestContext();

    const first = await createProductRequest(token, 'key-replay-1').expect(201);
    const second = await createProductRequest(token, 'key-replay-1').expect(201);

    assert.equal(String(first.body.product._id), String(second.body.product._id));
    assert.equal(second.headers['idempotency-replayed'], 'true');
    assert.equal(first.headers['idempotency-replayed'], undefined, 'the original is not a replay');
    assert.equal(await Product.countDocuments({}), 1);
  });

  it('records the outcome before answering, so a replay is never missed', async () => {
    const { token } = await createTestContext();

    await createProductRequest(token, 'key-durable-1').expect(201);

    // The response has already been received by the client here. If the completion write
    // were fire-and-forget, this record could still read `processing`.
    const record = await IdempotencyKey.findOne({ key: 'key-durable-1' });
    assert.equal(record.status, 'completed');
    assert.equal(record.responseStatus, 201);
    assert.ok(record.responseBody.product._id);
  });

  it('scopes keys per business', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();

    await createProductRequest(mine.token, 'key-shared-1').expect(201);
    await createProductRequest(theirs.token, 'key-shared-1').expect(201);

    assert.equal(await Product.countDocuments({}), 2);
  });
});

describe('idempotency: duplicate detection', () => {
  it('rejects the same key carrying a different request', async () => {
    const { token } = await createTestContext();

    await createProductRequest(token, 'key-reuse-1').expect(201);
    const response = await createProductRequest(token, 'key-reuse-1', { ...payload, price: 999 }).expect(409);

    assert.equal(response.body.details.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(await Product.countDocuments({}), 1);
  });

  it('treats a reordered but identical body as the same request', async () => {
    const { token } = await createTestContext();

    await createProductRequest(token, 'key-order-1', { name: 'A', price: 10, stockQuantity: 1 }).expect(201);
    const second = await createProductRequest(token, 'key-order-1', { stockQuantity: 1, price: 10, name: 'A' }).expect(201);

    assert.equal(second.headers['idempotency-replayed'], 'true');
  });
});

describe('idempotency: concurrency and retry', () => {
  it('lets exactly one of two simultaneous requests do the work', async () => {
    const { token } = await createTestContext();

    const responses = await Promise.all([
      createProductRequest(token, 'key-race-1'),
      createProductRequest(token, 'key-race-1')
    ]);

    assert.equal(await Product.countDocuments({}), 1, 'the write happens once');
    responses.forEach((response) => assert.ok([201, 409].includes(response.status)));

    const inProgress = responses.find((response) => response.status === 409);
    if (inProgress) {
      assert.equal(inProgress.body.details.code, 'IDEMPOTENCY_REQUEST_IN_PROGRESS');
      assert.equal(inProgress.headers['retry-after'], '1');
    }
  });

  it('refuses a retry while the original is still in flight', async () => {
    const { token } = await createTestContext();

    // The completed record carries the hash the middleware computes for this exact request,
    // so putting it back into `processing` with a fresh lock reproduces an in-flight retry.
    await createProductRequest(token, 'key-inflight-1').expect(201);
    await IdempotencyKey.updateOne(
      { key: 'key-inflight-1' },
      { $set: { status: 'processing', responseBody: null, responseStatus: null, lockedAt: new Date() } }
    );

    const response = await createProductRequest(token, 'key-inflight-1').expect(409);

    assert.equal(response.body.details.code, 'IDEMPOTENCY_REQUEST_IN_PROGRESS');
    assert.equal(response.headers['retry-after'], '1');
    assert.equal(await Product.countDocuments({}), 1, 'a live lock never re-executes');
  });

  it('reclaims a lock abandoned by a dead process and retries the operation', async () => {
    const { token } = await createTestContext();

    await createProductRequest(token, 'key-stale-1').expect(201);
    // Simulate the crash: the operation is marked as if it never finished, with a lock
    // older than the timeout.
    await IdempotencyKey.updateOne(
      { key: 'key-stale-1' },
      { $set: { status: 'processing', responseBody: null, responseStatus: null, lockedAt: new Date(Date.now() - 120_000) } }
    );

    await createProductRequest(token, 'key-stale-1').expect(201);

    assert.equal(await Product.countDocuments({}), 2, 'a reclaimed lock re-executes');
    assert.equal((await IdempotencyKey.findOne({ key: 'key-stale-1' })).status, 'completed');
  });

  it('re-executes after a stored server failure instead of replaying it', async () => {
    const { token } = await createTestContext();

    await createProductRequest(token, 'key-failed-1').expect(201);
    await IdempotencyKey.updateOne(
      { key: 'key-failed-1' },
      { $set: { status: 'failed', responseStatus: 500, responseBody: null } }
    );

    await createProductRequest(token, 'key-failed-1').expect(201);
    assert.equal(await Product.countDocuments({}), 2);
  });
});

describe('idempotency: key handling and TTL', () => {
  it('runs normally and stores nothing when no key is sent', async () => {
    const { token } = await createTestContext();

    await api().post('/api/v1/products').set(authHeader(token)).send(payload).expect(201);

    assert.equal(await IdempotencyKey.countDocuments({}), 0);
  });

  it('rejects an over-long key with 400 rather than failing to save it', async () => {
    const { token } = await createTestContext();

    const response = await createProductRequest(token, 'k'.repeat(181)).expect(400);

    assert.equal(response.body.details.code, 'IDEMPOTENCY_KEY_INVALID');
    assert.equal(await Product.countDocuments({}), 0);
  });

  it('expires records 30 days out, swept by a TTL index', async () => {
    const { token } = await createTestContext();

    await createProductRequest(token, 'key-ttl-1').expect(201);

    const record = await IdempotencyKey.findOne({ key: 'key-ttl-1' });
    const days = (record.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 29 && days <= 30, `expected a ~30 day TTL, got ${days}`);

    await IdempotencyKey.createIndexes();
    const indexes = await IdempotencyKey.collection.indexes();
    const ttlIndex = indexes.find((index) => index.key.expiresAt === 1);
    assert.ok(ttlIndex, 'expiresAt must carry a TTL index or records accumulate forever');
    assert.equal(ttlIndex.expireAfterSeconds, 0);
  });
});
