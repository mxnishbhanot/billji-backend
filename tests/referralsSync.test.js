import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Referral from '../src/models/Referral.js';
import RewardGrant from '../src/models/RewardGrant.js';
import Subscription from '../src/models/Subscription.js';
import { SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION } from '../src/modules/sync/protocol.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { ensureSubscription } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

/**
 * A referral code applied through the offline sync push.
 *
 * The rule this file holds: the device sends a string and nothing else. Validity, eligibility and the
 * reward are decided on the server, exactly as they are online — and a replayed operation, which the
 * retry engine WILL produce, must never mint a second free month.
 */

process.env.SYNC_SAFETY_LAG_MS = '0';

useMongoTestDb();

const api = () => request(app);
const syncHeaders = (token) => ({ ...authHeader(token), [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION) });
const push = (token, ops) => api().post('/api/v1/sync/push').set(syncHeaders(token)).send({ ops });

const referralOp = ({ code, opId = 'op-ref-1', clientId = 'client-ref-1' }) => ({
  opId,
  entity: 'referral',
  opType: 'create',
  clientId,
  payload: { code, clientId }
});

const seeded = async () => {
  clearPlanCache();
  await bootstrapBilling();
};

const referrer = async () => {
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });
  const { body } = await api().get('/api/v1/referrals/me').set(authHeader(context.token)).expect(200);
  return { ...context, code: body.code };
};

const joiner = async () => {
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });
  return context;
};

describe('applying a referral through sync push', () => {
  it('grants the free month from a pushed operation', async () => {
    await seeded();
    const inviter = await referrer();
    const device = await joiner();

    const { body } = await push(device.token, [referralOp({ code: inviter.code })]).expect(200);

    assert.equal(body.results[0].status, 'ok');
    const referral = await Referral.findOne({ referredUser: device.user._id });
    assert.equal(referral.status, 'pending');
    assert.equal(referral.clientId, 'client-ref-1');

    const subscription = await Subscription.findOne({ business: device.business._id });
    assert.equal(subscription.planKey, 'pro');
    assert.equal(await RewardGrant.countDocuments({ rule: 'referral_signup' }), 1);
  });

  it('is idempotent when the retry engine sends the same operation again', async () => {
    await seeded();
    const inviter = await referrer();
    const device = await joiner();
    const op = referralOp({ code: inviter.code, opId: 'op-ref-2', clientId: 'client-ref-2' });

    const first = await push(device.token, [op]).expect(200);
    const second = await push(device.token, [op]).expect(200);

    assert.equal(first.results?.[0]?.status ?? first.body.results[0].status, 'ok');
    assert.equal(second.body.results[0].status, 'ok');
    assert.equal(await Referral.countDocuments({ referredUser: device.user._id }), 1);
    assert.equal(await RewardGrant.countDocuments({ rule: 'referral_signup' }), 1);

    // One free month, not two: the period is 30 days from the first grant, unchanged by the replay.
    const subscription = await Subscription.findOne({ business: device.business._id });
    const days = Math.round((subscription.currentPeriodEnd - subscription.currentPeriodStart) / (24 * 60 * 60 * 1000));
    assert.equal(days, 30);
  });

  it('grants nothing twice when a new operation carries an already-used code', async () => {
    await seeded();
    const inviter = await referrer();
    const device = await joiner();

    await push(device.token, [referralOp({ code: inviter.code, opId: 'op-ref-3', clientId: 'client-ref-3' })]).expect(200);
    // A different op id and client id: the device queued it twice, or a reinstall re-queued it.
    const { body } = await push(device.token, [
      referralOp({ code: inviter.code, opId: 'op-ref-4', clientId: 'client-ref-4' })
    ]).expect(200);

    // 409 travels back as `conflict` (the push protocol's mapping for every 409), carrying the
    // eligibility code. The device turns codes like this one into `dead` rather than offering a
    // Keep local / Keep server choice — there is nothing to rebase about an already-used code.
    assert.equal(body.results[0].status, 'conflict');
    assert.equal(body.results[0].statusCode, 409);
    assert.equal(body.results[0].code, 'REFERRAL_ALREADY_APPLIED');
    assert.equal(await RewardGrant.countDocuments({ rule: 'referral_signup' }), 1);
  });

  it('reports an invalid code as a 4xx so the client stops retrying', async () => {
    await seeded();
    const device = await joiner();

    const { body } = await push(device.token, [
      referralOp({ code: 'ZZZZZZZZ', opId: 'op-ref-5', clientId: 'client-ref-5' })
    ]).expect(200);

    const result = body.results[0];
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'REFERRAL_CODE_INVALID');
    // 4xx is what classifyResult turns into `dead` on the device — retrying a wrong code for ever
    // would keep a permanent row on the Sync Issues screen.
    assert.ok(result.statusCode >= 400 && result.statusCode < 500, `expected a 4xx, got ${result.statusCode}`);
    assert.equal(await Referral.countDocuments({}), 0);
  });

  it('refuses a self-referral pushed from a device', async () => {
    await seeded();
    const inviter = await referrer();

    const { body } = await push(inviter.token, [
      referralOp({ code: inviter.code, opId: 'op-ref-6', clientId: 'client-ref-6' })
    ]).expect(200);

    assert.equal(body.results[0].statusCode, 403);
    assert.equal(await Referral.countDocuments({}), 0);
  });

  it('rejects a pushed operation from a member without billing permission', async () => {
    await seeded();
    const inviter = await referrer();
    const staff = await createTestContext({ roleKey: 'staff' });
    await ensureSubscription({ business: staff.business });

    const { body } = await push(staff.token, [
      referralOp({ code: inviter.code, opId: 'op-ref-7', clientId: 'client-ref-7' })
    ]).expect(200);

    assert.equal(body.results[0].statusCode, 403);
    assert.equal(await Referral.countDocuments({}), 0);
  });
});
