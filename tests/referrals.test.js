import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Referral from '../src/models/Referral.js';
import RewardGrant from '../src/models/RewardGrant.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import User from '../src/models/User.js';
import { applyRefund } from '../src/services/billingService.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { onPaidSubscription } from '../src/modules/referrals/service.js';
import { ensureSubscription } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';
import { configureRazorpay, paymentSignature, stubRazorpay, unconfigureRazorpay } from './helpers/razorpayStub.js';

/**
 * Referral rules.
 *
 * The two facts this file exists to defend: a free month is granted exactly once per referred user,
 * and eligibility — not a time window — is what decides whether a code can still be used.
 */

useMongoTestDb();

const DAY = 24 * 60 * 60 * 1000;
let razorpay;

beforeEach(() => {
  configureRazorpay();
  razorpay = stubRazorpay();
});

afterEach(() => {
  razorpay.restore();
  unconfigureRazorpay();
});

const api = () => request(app);

const seeded = async () => {
  clearPlanCache();
  await bootstrapBilling();
};

/** A referrer with a code, ready to share. */
const referrer = async () => {
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });
  const { body } = await api().get('/api/v1/referrals/me').set(authHeader(context.token)).expect(200);
  return { ...context, code: body.code };
};

const registerWith = (payload) => api().post('/api/v1/auth/register').send(payload);

const signup = async ({ code, email = `ref-${Math.random().toString(36).slice(2, 9)}@billji.local` } = {}) => {
  const response = await registerWith({ name: 'Referred Shop', email, password: 'password123', referralCode: code });
  assert.equal(response.status, 201, response.text);
  return response;
};

const applyCode = (token, code) =>
  api().post('/api/v1/referrals/apply').set(authHeader(token)).send({ code });

// The razorpay stub answers with one fixed order id, so a second purchase in the same test needs a
// fresh one — otherwise it collides with the first payment row's unique providerRefs.orderId.
let orderSeq = 0;

const buyPro = async (token) => {
  orderSeq += 1;
  razorpay.state.orderId = `order_TEST_${orderSeq}`;
  razorpay.state.paymentId = `pay_TEST_${orderSeq}`;
  const started = await api()
    .post('/api/v1/billing/checkout')
    .set(authHeader(token))
    .send({ planKey: 'pro', interval: 'month' })
    .expect(201);
  const { orderId } = started.body.checkout;
  const paymentId = razorpay.state.paymentId;
  await api()
    .post('/api/v1/billing/checkout/verify')
    .set(authHeader(token))
    .send({ orderId, paymentId, signature: paymentSignature({ orderId, paymentId }) })
    .expect(200);
  return SubscriptionPayment.findOne({ 'providerRefs.orderId': orderId });
};

describe('referral codes', () => {
  it('mints a permanent, human-readable code on first read and never changes it', async () => {
    await seeded();
    const { token } = await referrer();

    const first = await api().get('/api/v1/referrals/me').set(authHeader(token)).expect(200);
    const second = await api().get('/api/v1/referrals/me').set(authHeader(token)).expect(200);

    assert.equal(first.body.code, second.body.code);
    assert.match(first.body.code, /^[2-9A-HJ-KMNP-Z]{8}$/);
  });
});

describe('applying a referral at signup', () => {
  it('grants the referred user 30 days of Pro, priced at zero', async () => {
    await seeded();
    const inviter = await referrer();

    const response = await signup({ code: inviter.code });

    assert.equal(response.body.referral.applied, true);
    assert.equal(response.body.user.subscription.planKey, 'pro');

    const referral = await Referral.findOne({ code: inviter.code });
    assert.equal(String(referral.referrer), String(inviter.user._id));
    assert.equal(referral.status, 'pending');

    const subscription = await Subscription.findOne({ business: response.body.user.businessId });
    const days = Math.round((subscription.currentPeriodEnd - subscription.currentPeriodStart) / DAY);
    assert.equal(days, 30);
    assert.equal(subscription.pricing.amount, 0);
    // Not a trial: the referred user genuinely holds a paid-shape Pro subscription.
    assert.equal(subscription.status, 'active');
    assert.equal(subscription.trial.used, false);
  });

  it('records referredBy on the user so eligibility needs no query', async () => {
    await seeded();
    const inviter = await referrer();
    const response = await signup({ code: inviter.code });

    const user = await User.findById(response.body.user.id);
    assert.equal(String(user.referredBy), String(inviter.user._id));
  });

  it('creates the account anyway when the code does not exist', async () => {
    await seeded();
    const response = await signup({ code: 'ZZZZZZZZ' });

    assert.equal(response.body.referral.applied, false);
    assert.equal(response.body.referral.reason, 'REFERRAL_CODE_INVALID');
    assert.equal(response.body.user.subscription.planKey, 'starter');
    assert.equal(await Referral.countDocuments({}), 0);
  });

  it('creates the account normally when no code is given', async () => {
    await seeded();
    const response = await signup();

    assert.equal(response.body.referral, null);
    assert.equal(response.body.user.subscription.planKey, 'starter');
  });
});

describe('eligibility, not a time window', () => {
  it('lets a user apply a code long after signing up', async () => {
    await seeded();
    const inviter = await referrer();
    const later = await createTestContext();
    await ensureSubscription({ business: later.business });
    // Backdate the account well past any plausible signup window.
    await User.updateOne({ _id: later.user._id }, { $set: { createdAt: new Date(Date.now() - 90 * DAY) } });

    const response = await applyCode(later.token, inviter.code).expect(201);

    assert.equal(response.body.referral.status, 'pending');
    assert.equal(response.body.subscription.planKey, 'pro');
  });

  it('refuses a second code once one has been used', async () => {
    await seeded();
    const first = await referrer();
    const second = await referrer();
    const joined = await signup({ code: first.code });
    const token = joined.body.accessToken;

    const response = await applyCode(token, second.code).expect(409);
    assert.equal(response.body.details.code, 'REFERRAL_ALREADY_APPLIED');
    assert.equal(await Referral.countDocuments({}), 1);
  });

  it('refuses a code after the user has paid for a plan', async () => {
    await seeded();
    const inviter = await referrer();
    const buyer = await createTestContext();
    await ensureSubscription({ business: buyer.business });
    await buyPro(buyer.token);

    const response = await applyCode(buyer.token, inviter.code).expect(409);
    assert.equal(response.body.details.code, 'REFERRAL_NOT_ELIGIBLE_PAID');
  });

  it('keeps refusing after that payment is refunded', async () => {
    await seeded();
    const inviter = await referrer();
    const buyer = await createTestContext();
    await ensureSubscription({ business: buyer.business });
    const payment = await buyPro(buyer.token);
    await applyRefund({ payment, refundId: 'rfnd_test_1', amount: payment.netAmount });

    const response = await applyCode(buyer.token, inviter.code).expect(409);
    assert.equal(response.body.details.code, 'REFERRAL_NOT_ELIGIBLE_PAID');
  });

  it('reports eligibility so the app can hide the entry point', async () => {
    await seeded();
    const inviter = await referrer();
    const joined = await signup({ code: inviter.code });

    const mine = await api()
      .get('/api/v1/referrals/me/eligibility')
      .set(authHeader(joined.body.accessToken))
      .expect(200);
    assert.equal(mine.body.eligible, false);
    assert.equal(mine.body.reason, 'REFERRAL_ALREADY_APPLIED');

    const fresh = await createTestContext();
    const theirs = await api().get('/api/v1/referrals/me/eligibility').set(authHeader(fresh.token)).expect(200);
    assert.equal(theirs.body.eligible, true);
  });
});

describe('abuse', () => {
  it('refuses a user their own code', async () => {
    await seeded();
    const inviter = await referrer();

    const response = await applyCode(inviter.token, inviter.code).expect(403);
    assert.equal(response.body.details.code, 'REFERRAL_SELF');
    assert.equal(await Referral.countDocuments({}), 0);
  });

  it('never lets one user be referred twice, whatever races', async () => {
    await seeded();
    const inviter = await referrer();
    const joiner = await createTestContext();

    const results = await Promise.allSettled([
      applyCode(joiner.token, inviter.code),
      applyCode(joiner.token, inviter.code)
    ]);
    const statuses = results.map((result) => result.value?.status).sort();

    assert.equal(await Referral.countDocuments({ referredUser: joiner.user._id }), 1);
    assert.equal(await RewardGrant.countDocuments({ rule: 'referral_signup' }), 1);
    assert.ok(statuses.includes(201), `expected one success, got ${statuses}`);
  });

  it('rate-limits a burst from one network without burning eligibility', async () => {
    await seeded();
    const inviter = await referrer();
    const previous = process.env.REFERRAL_MAX_SIGNUPS_PER_IP_PER_DAY;
    process.env.REFERRAL_MAX_SIGNUPS_PER_IP_PER_DAY = '1';

    try {
      const { applyReferral } = await import('../src/modules/referrals/service.js');
      const fakeRequest = { ip: '203.0.113.7', get: () => '' };

      const first = await createTestContext();
      await ensureSubscription({ business: first.business });
      await applyReferral({ user: first.user, business: first.business, code: inviter.code, req: fakeRequest });

      const second = await createTestContext();
      await ensureSubscription({ business: second.business });
      await assert.rejects(
        () => applyReferral({ user: second.user, business: second.business, code: inviter.code, req: fakeRequest }),
        (error) => error.details?.code === 'REFERRAL_LIMIT_REACHED'
      );

      // Nothing written for the refused attempt, so tomorrow they can try again — the limit must not
      // become a permanent verdict on a shared hotspot.
      assert.equal(await Referral.countDocuments({}), 1);
      const stillEligible = await User.findById(second.user._id);
      assert.equal(stillEligible.referredBy, null);
    } finally {
      if (previous === undefined) delete process.env.REFERRAL_MAX_SIGNUPS_PER_IP_PER_DAY;
      else process.env.REFERRAL_MAX_SIGNUPS_PER_IP_PER_DAY = previous;
    }
  });

  it('validates a code publicly without leaking the referrer identity', async () => {
    await seeded();
    const inviter = await referrer();

    const good = await api().post('/api/v1/public/referrals/validate').send({ code: inviter.code }).expect(200);
    assert.equal(good.body.valid, true);
    assert.equal(good.body.referrerName, 'Test User');
    assert.equal(good.body.email, undefined);

    const bad = await api().post('/api/v1/public/referrals/validate').send({ code: 'ZZZZZZZZ' }).expect(200);
    assert.equal(bad.body.valid, false);
  });
});

describe("the referrer's reward", () => {
  it('grants a free month on the first paid subscription, and only then', async () => {
    await seeded();
    const inviter = await referrer();
    const joined = await signup({ code: inviter.code });
    const joinedToken = joined.body.accessToken;

    const before = await Subscription.findOne({ business: inviter.business._id });
    await buyPro(joinedToken);

    const referral = await Referral.findOne({ referredUser: joined.body.user.id });
    assert.equal(referral.status, 'converted');
    assert.ok(referral.qualifyingPayment);

    const grants = await RewardGrant.find({ rule: 'referral_conversion' });
    assert.equal(grants.length, 1);
    assert.equal(grants[0].grant.days, 30);
    assert.equal(String(grants[0].beneficiary), String(inviter.user._id));

    const after = await Subscription.findOne({ business: inviter.business._id });
    assert.equal(after.planKey, 'pro');
    assert.ok(after.currentPeriodEnd > (before.currentPeriodEnd ?? new Date()));
  });

  it('pays nothing on a renewal', async () => {
    await seeded();
    const inviter = await referrer();
    const joined = await signup({ code: inviter.code });
    const token = joined.body.accessToken;

    await buyPro(token);
    const afterFirst = await Subscription.findOne({ business: inviter.business._id });
    await buyPro(token);

    assert.equal(await RewardGrant.countDocuments({ rule: 'referral_conversion' }), 1);
    const afterSecond = await Subscription.findOne({ business: inviter.business._id });
    assert.equal(afterSecond.currentPeriodEnd.getTime(), afterFirst.currentPeriodEnd.getTime());
  });

  it('is idempotent when the conversion hook runs again for the same payment', async () => {
    await seeded();
    const inviter = await referrer();
    const joined = await signup({ code: inviter.code });
    const payment = await buyPro(joined.body.accessToken);

    const replay = await onPaidSubscription({ payment });

    assert.equal(replay.converted, false);
    assert.equal(await RewardGrant.countDocuments({ rule: 'referral_conversion' }), 1);
  });

  it('adds days on top of a period the referrer already paid for', async () => {
    await seeded();
    const inviter = await referrer();
    await buyPro(inviter.token);
    const paidUntil = (await Subscription.findOne({ business: inviter.business._id })).currentPeriodEnd;

    const joined = await signup({ code: inviter.code });
    await buyPro(joined.body.accessToken);

    const extended = await Subscription.findOne({ business: inviter.business._id });
    const added = Math.round((extended.currentPeriodEnd - paidUntil) / DAY);
    assert.equal(added, 30);
  });

  it('never downgrades a referrer who is on a higher plan', async () => {
    await seeded();
    const inviter = await referrer();
    const businessPlanEnd = new Date(Date.now() + 40 * DAY);
    const { applyPlan } = await import('../src/services/subscriptionService.js');
    const Plan = (await import('../src/models/Plan.js')).default;
    await applyPlan({
      business: inviter.business._id,
      plan: await Plan.findOne({ key: 'business' }),
      interval: 'month',
      periodEnd: businessPlanEnd
    });

    const joined = await signup({ code: inviter.code });
    await buyPro(joined.body.accessToken);

    const subscription = await Subscription.findOne({ business: inviter.business._id });
    assert.equal(subscription.planKey, 'business');
    const added = Math.round((subscription.currentPeriodEnd - businessPlanEnd) / DAY);
    assert.equal(added, 30);
  });

  it('reverses the reward when the qualifying payment is refunded', async () => {
    await seeded();
    const inviter = await referrer();
    const joined = await signup({ code: inviter.code });
    const beforeReward = (await Subscription.findOne({ business: inviter.business._id })).currentPeriodEnd;
    const payment = await buyPro(joined.body.accessToken);
    const rewarded = (await Subscription.findOne({ business: inviter.business._id })).currentPeriodEnd;

    await applyRefund({ payment, refundId: 'rfnd_test_2', amount: payment.netAmount });

    const grant = await RewardGrant.findOne({ rule: 'referral_conversion' });
    assert.equal(grant.status, 'reversed');

    // The referral goes back to pending: the referred user may buy again, and that purchase should
    // pay out exactly as this one was meant to.
    const referral = await Referral.findOne({ referredUser: joined.body.user.id });
    assert.equal(referral.status, 'pending');
    assert.equal(referral.qualifyingPayment, null);

    const after = await Subscription.findOne({ business: inviter.business._id });
    assert.ok(after.currentPeriodEnd < rewarded);
    assert.ok(after.currentPeriodEnd >= (beforeReward ?? new Date(0)));
  });

  it('does not mint a second month when a reopened referral converts again', async () => {
    await seeded();
    const inviter = await referrer();
    const joined = await signup({ code: inviter.code });
    const token = joined.body.accessToken;

    const payment = await buyPro(token);
    await applyRefund({ payment, refundId: 'rfnd_test_3', amount: payment.netAmount });
    await buyPro(token);

    // One grant, still reversed: the free month was taken back and the ledger says why. A second
    // grant would be BillJi paying twice for one referred customer.
    assert.equal(await RewardGrant.countDocuments({ rule: 'referral_conversion' }), 1);
  });
});

describe('referral reads', () => {
  it('reports stats and a masked list of who joined', async () => {
    await seeded();
    const inviter = await referrer();
    const joined = await signup({ code: inviter.code });
    await buyPro(joined.body.accessToken);

    const stats = await api().get('/api/v1/referrals/me/stats').set(authHeader(inviter.token)).expect(200);
    assert.deepEqual(stats.body.stats, {
      totalReferrals: 1,
      pending: 0,
      converted: 1,
      rewardsEarned: 1,
      freeDaysEarned: 30
    });

    const list = await api().get('/api/v1/referrals/me/referrals').set(authHeader(inviter.token)).expect(200);
    assert.equal(list.body.referrals.length, 1);
    assert.equal(list.body.referrals[0].status, 'converted');
    // Masked: a referrer sees that someone joined, never their full identity.
    assert.equal(list.body.referrals[0].name, 'Referred S.');
    assert.equal(list.body.referrals[0].email, undefined);

    const rewards = await api().get('/api/v1/referrals/me/rewards').set(authHeader(inviter.token)).expect(200);
    assert.equal(rewards.body.rewards[0].rule, 'referral_conversion');
    assert.equal(rewards.body.rewards[0].days, 30);
  });
});
