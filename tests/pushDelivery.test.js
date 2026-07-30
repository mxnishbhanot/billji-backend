import request from 'supertest';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import app from '../src/app.js';
import BusinessMember from '../src/models/BusinessMember.js';
import DeviceToken from '../src/models/DeviceToken.js';
import UserNotificationPreference from '../src/models/UserNotificationPreference.js';
import { upsertNotification } from '../src/services/notificationService.js';
import { sendPushForNotification, setPushSenderForTests } from '../src/services/pushService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

// Records what would have gone to FCM; `failures` maps a token to the error code the
// service should see for it.
const fakeSender = (failures = {}) => {
  const calls = [];
  const send = async (message) => {
    calls.push(message);
    return {
      responses: message.tokens.map((token) =>
        failures[token] ? { success: false, error: { code: failures[token] } } : { success: true }
      )
    };
  };
  send.calls = calls;
  return send;
};

const registerToken = (business, user, token, overrides = {}) =>
  DeviceToken.create({ business: business._id, user: user._id, token, platform: 'android', ...overrides });

const notify = (business, overrides = {}) =>
  upsertNotification({
    business: business._id,
    notificationId: 'overdue-invoice:demo',
    type: 'overdue-invoice',
    resourceType: 'invoice',
    tone: 'danger',
    title: 'INV-0001 is overdue',
    description: 'Ramesh payment was due on 01 Jul 2026.',
    to: '/invoices/demo',
    ...overrides
  });

afterEach(() => {
  setPushSenderForTests(null);
});

describe('push delivery', () => {
  it('sends one message carrying the notification title, body and deep link', async () => {
    const { business, user } = await createTestContext();
    await registerToken(business, user, 'token-a');
    const send = fakeSender();
    setPushSenderForTests(send);

    const result = await sendPushForNotification({
      business: business._id,
      type: 'overdue-invoice',
      notificationId: 'overdue-invoice:x',
      title: 'INV-9 is overdue',
      description: 'Rs. 1,200 pending',
      to: '/invoices/x',
      tone: 'danger'
    });

    assert.equal(result.sent, 1);
    assert.equal(send.calls.length, 1);
    assert.deepEqual(send.calls[0].tokens, ['token-a']);
    assert.equal(send.calls[0].notification.title, 'INV-9 is overdue');
    assert.equal(send.calls[0].notification.body, 'Rs. 1,200 pending');
    assert.equal(send.calls[0].data.to, '/invoices/x');
    // Overdue money is high priority so it wakes the device.
    assert.equal(send.calls[0].android.priority, 'high');
  });

  it('does nothing when no sender is available (unconfigured, or any test run)', async () => {
    const { business, user } = await createTestContext();
    await registerToken(business, user, 'token-a');

    const result = await sendPushForNotification({ business: business._id, type: 'low-stock', title: 'x' });

    assert.equal(result.skipped, 'not_configured');
  });

  it('skips a user who turned the push channel off for that type', async () => {
    const { business, user } = await createTestContext();
    await registerToken(business, user, 'token-a');
    await UserNotificationPreference.create({
      business: business._id,
      user: user._id,
      preferences: { 'low-stock': { push: false } }
    });
    const send = fakeSender();
    setPushSenderForTests(send);

    const offType = await sendPushForNotification({ business: business._id, type: 'low-stock', title: 'Low stock' });
    assert.equal(offType.skipped, 'no_recipients');

    // Other types are unaffected — absence of a preference means enabled.
    const onType = await sendPushForNotification({ business: business._id, type: 'overdue-invoice', title: 'Overdue' });
    assert.equal(onType.sent, 1);
  });

  it('never pushes to the person who caused the notification', async () => {
    const { business, user } = await createTestContext();
    await registerToken(business, user, 'token-a');
    setPushSenderForTests(fakeSender());

    const result = await sendPushForNotification(
      { business: business._id, type: 'invoice-created', title: 'Invoice created' },
      { excludeUserId: user._id }
    );

    assert.equal(result.skipped, 'no_recipients');
  });

  it('never pushes to another business, even for a shared user', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();
    await registerToken(theirs.business, theirs.user, 'their-token');
    // Same person is an active member of both businesses, with a device on each.
    await BusinessMember.create({ business: theirs.business._id, user: mine.user._id, roleKey: 'staff', status: 'active' });
    await registerToken(theirs.business, mine.user, 'their-second-device');
    await registerToken(mine.business, mine.user, 'my-token');

    const send = fakeSender();
    setPushSenderForTests(send);

    await sendPushForNotification({ business: mine.business._id, type: 'overdue-invoice', title: 'Overdue' });

    assert.deepEqual(send.calls[0].tokens, ['my-token']);
  });

  it('deletes tokens FCM reports as dead and keeps the healthy ones', async () => {
    const { business, user } = await createTestContext();
    await registerToken(business, user, 'good-token');
    await registerToken(business, user, 'dead-token');
    setPushSenderForTests(fakeSender({ 'dead-token': 'messaging/registration-token-not-registered' }));

    const result = await sendPushForNotification({ business: business._id, type: 'overdue-invoice', title: 'Overdue' });

    assert.equal(result.sent, 1);
    assert.equal(result.pruned, 1);
    const remaining = await DeviceToken.find({ business: business._id }).lean();
    assert.deepEqual(remaining.map((row) => row.token), ['good-token']);
  });

  it('survives a sender that throws without failing the caller', async () => {
    const { business, user } = await createTestContext();
    await registerToken(business, user, 'token-a');
    setPushSenderForTests(async () => {
      throw new Error('FCM unavailable');
    });

    const result = await sendPushForNotification({ business: business._id, type: 'overdue-invoice', title: 'Overdue' });

    assert.equal(result.skipped, 'error');
  });
});

describe('push triggered by notifications', () => {
  it('pushes when a notification is first created but not when it is refreshed', async () => {
    const { business, user } = await createTestContext();
    await registerToken(business, user, 'token-a');
    const send = fakeSender();
    setPushSenderForTests(send);

    await notify(business);
    // The hourly reminder sweep rewrites the same row every hour; it must stay quiet.
    await notify(business, { description: 'Ramesh payment was due on 01 Jul 2026. Still unpaid.' });
    await notify(business);

    // upsertNotification fires the push without awaiting it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(send.calls.length, 1);
  });

  it('does not push the actor their own action', async () => {
    const { business, user } = await createTestContext();
    await registerToken(business, user, 'token-a');
    const send = fakeSender();
    setPushSenderForTests(send);

    await notify(business, { notificationId: 'invoice-created:demo', type: 'invoice-created', actor: user._id });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(send.calls.length, 0);
  });
});

describe('device registration API', () => {
  it('registers, moves and removes a device token', async () => {
    const first = await createTestContext();
    const second = await createTestContext();

    await api().post('/api/v1/notifications/devices').set(authHeader(first.token)).send({ token: 'fcm-token-1', platform: 'android' }).expect(200);
    assert.equal(await DeviceToken.countDocuments({ token: 'fcm-token-1' }), 1);

    // Same physical device, different account: the row moves instead of duplicating.
    await api().post('/api/v1/notifications/devices').set(authHeader(second.token)).send({ token: 'fcm-token-1', platform: 'android' }).expect(200);
    const rows = await DeviceToken.find({ token: 'fcm-token-1' }).lean();
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].user), String(second.user._id));

    // The previous owner cannot delete a token that is no longer theirs.
    await api().delete('/api/v1/notifications/devices/fcm-token-1').set(authHeader(first.token)).expect(200);
    assert.equal(await DeviceToken.countDocuments({ token: 'fcm-token-1' }), 1);

    await api().delete('/api/v1/notifications/devices/fcm-token-1').set(authHeader(second.token)).expect(200);
    assert.equal(await DeviceToken.countDocuments({ token: 'fcm-token-1' }), 0);
  });

  it('rejects a missing or absurd token', async () => {
    const { token } = await createTestContext();

    await api().post('/api/v1/notifications/devices').set(authHeader(token)).send({}).expect(422);
    await api().post('/api/v1/notifications/devices').set(authHeader(token)).send({ token: 'short' }).expect(422);
  });
});
