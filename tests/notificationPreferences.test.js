import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

describe('notification preferences API', () => {
  it('returns empty preferences by default', async () => {
    const { token } = await createTestContext();
    const res = await api().get('/api/v1/notifications/preferences').set(authHeader(token)).expect(200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.preferences, {});
  });

  it('persists updates and strips unknown types and channels', async () => {
    const { token } = await createTestContext();
    const put = await api()
      .put('/api/v1/notifications/preferences')
      .set(authHeader(token))
      .send({
        preferences: {
          'low-stock': { inApp: false, push: true, sms: true },
          'made-up-type': { inApp: false },
          'payment-received': { inApp: 'nope' }
        }
      })
      .expect(200);
    assert.deepEqual(put.body.preferences, { 'low-stock': { inApp: false, push: true } });

    const get = await api().get('/api/v1/notifications/preferences').set(authHeader(token)).expect(200);
    assert.deepEqual(get.body.preferences, { 'low-stock': { inApp: false, push: true } });
  });

  it('filters notification list and unread count by disabled types', async () => {
    const { business, token } = await createTestContext();
    await createProduct(business, { stockQuantity: 1, lowStockThreshold: 5 });

    const before = await api().get('/api/v1/notifications').set(authHeader(token)).expect(200);
    const lowStockBefore = before.body.notifications.filter((n) => n.type === 'low-stock');
    assert.ok(lowStockBefore.length >= 1, 'expected a low-stock notification to materialize');
    const unreadBefore = before.body.unreadCount;

    await api()
      .put('/api/v1/notifications/preferences')
      .set(authHeader(token))
      .send({ preferences: { 'low-stock': { inApp: false } } })
      .expect(200);

    const after = await api().get('/api/v1/notifications').set(authHeader(token)).expect(200);
    const lowStockAfter = after.body.notifications.filter((n) => n.type === 'low-stock');
    assert.equal(lowStockAfter.length, 0, 'low-stock notifications should be hidden');
    assert.ok(after.body.unreadCount < unreadBefore, 'unread count should drop after disabling the type');
  });

  it('blocks viewers from updating but allows reading', async () => {
    const viewer = await createTestContext({ roleKey: 'viewer' });
    await api().get('/api/v1/notifications/preferences').set(authHeader(viewer.token)).expect(200);
    await api()
      .put('/api/v1/notifications/preferences')
      .set(authHeader(viewer.token))
      .send({ preferences: { 'low-stock': { inApp: false } } })
      .expect(403);
  });
});
