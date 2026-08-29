import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import { bootstrapRbac } from '../src/bootstrap/rbac.js';
import Plan from '../src/models/Plan.js';
import Referral from '../src/models/Referral.js';
import ReferralReward from '../src/models/ReferralReward.js';
import Subscription from '../src/models/Subscription.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { applyPlan, ensureSubscription } from '../src/services/subscriptionService.js';
import { applyReferral, convertReferral, ensureReferralCode } from '../src/modules/referrals/service.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const DAY = 24 * 60 * 60 * 1000;

const seeded = async () => {
  clearPlanCache();
  await bootstrapRbac();
  await bootstrapBilling();
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });
  return context;
};

describe('referrals', () => {
  it('gives the referred business a free month of Pro and leaves the referrer waiting', async () => {
    const referrer = await seeded();
    const referred = await seeded();
    const code = await ensureReferralCode(referrer.business._id);

    await applyReferral({ business: referred.business, code });

    const subscription = await Subscription.findOne({ business: referred.business._id });
    assert.equal(subscription.planKey, 'pro');
    const days = Math.round((subscription.currentPeriodEnd - Date.now()) / DAY);
    assert.ok(days >= 29 && days <= 30, `expected ~30 free days, got ${days}`);

    // The referrer is paid on conversion, not on signup.
    assert.equal(await ReferralReward.countDocuments({ business: referrer.business._id }), 0);
    assert.equal((await Referral.findOne({ business: referred.business._id })).status, 'pending');
  });

  it('extends the referrer by a month on their own plan once the referred business pays', async () => {
    const referrer = await seeded();
    const referred = await seeded();
    const code = await ensureReferralCode(referrer.business._id);

    // The referrer is a paying Business-plan customer: the reward must extend that, not switch them.
    const businessPlan = await Plan.findOne({ key: 'business' });
    await applyPlan({ business: referrer.business, plan: businessPlan, interval: 'month' });
    const before = await Subscription.findOne({ business: referrer.business._id });

    await applyReferral({ business: referred.business, code });
    await convertReferral({ business: referred.business });

    const after = await Subscription.findOne({ business: referrer.business._id });
    assert.equal(after.planKey, 'business', 'the referrer keeps the plan they were on');
    const added = Math.round((after.currentPeriodEnd - before.currentPeriodEnd) / DAY);
    assert.equal(added, 30);
    assert.equal((await Referral.findOne({ business: referred.business._id })).status, 'converted');
  });

  it('grants a free-plan referrer a month of Pro, since there is no period to extend', async () => {
    const referrer = await seeded();
    const referred = await seeded();
    const code = await ensureReferralCode(referrer.business._id);

    await applyReferral({ business: referred.business, code });
    await convertReferral({ business: referred.business });

    const after = await Subscription.findOne({ business: referrer.business._id });
    assert.equal(after.planKey, 'pro');
    assert.ok(after.currentPeriodEnd, 'a granted month has to end');
  });

  it('pays the referrer once even if the conversion runs twice', async () => {
    const referrer = await seeded();
    const referred = await seeded();
    const code = await ensureReferralCode(referrer.business._id);

    await applyReferral({ business: referred.business, code });
    await convertReferral({ business: referred.business });
    const first = await Subscription.findOne({ business: referrer.business._id });

    // A replayed webhook, or reconciliation finishing a half-applied capture.
    await convertReferral({ business: referred.business });

    const second = await Subscription.findOne({ business: referrer.business._id });
    assert.equal(second.currentPeriodEnd.getTime(), first.currentPeriodEnd.getTime());
    assert.equal(await ReferralReward.countDocuments({ business: referrer.business._id }), 1);
  });

  it('refuses a self-referral, an unknown code, and a second code', async () => {
    const referrer = await seeded();
    const referred = await seeded();
    const code = await ensureReferralCode(referrer.business._id);
    const ownCode = await ensureReferralCode(referred.business._id);

    await assert.rejects(
      () => applyReferral({ business: referred.business, code: ownCode }),
      (error) => error.details?.code === 'REFERRAL_SELF'
    );
    await assert.rejects(
      () => applyReferral({ business: referred.business, code: 'NOPENOPE' }),
      (error) => error.details?.code === 'REFERRAL_CODE_INVALID'
    );

    await applyReferral({ business: referred.business, code });
    await assert.rejects(
      () => applyReferral({ business: referred.business, code }),
      (error) => error.details?.code === 'REFERRAL_ALREADY_APPLIED'
    );
  });

  it('refuses a business that has already paid', async () => {
    const referrer = await seeded();
    const referred = await seeded();
    const code = await ensureReferralCode(referrer.business._id);

    const { default: SubscriptionPayment } = await import('../src/models/SubscriptionPayment.js');
    await SubscriptionPayment.create({
      business: referred.business._id,
      planKey: 'pro',
      billingInterval: 'month',
      amount: 24900,
      netAmount: 24900,
      currency: 'INR',
      status: 'captured',
      provider: 'razorpay'
    });

    await assert.rejects(
      () => applyReferral({ business: referred.business, code }),
      (error) => error.details?.code === 'REFERRAL_NOT_ELIGIBLE_PAID'
    );
  });

  it('reports eligibility and the caller’s own code over HTTP', async () => {
    const { token } = await seeded();

    const eligibility = await request(app).get('/api/v1/referrals/me/eligibility').set(authHeader(token));
    assert.equal(eligibility.status, 200, eligibility.text);
    assert.equal(eligibility.body.eligible, true);
    assert.equal(eligibility.body.reason, null);
    assert.match(eligibility.body.code, /^[A-Z0-9]{8}$/);

    const me = await request(app).get('/api/v1/referrals/me').set(authHeader(token));
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.code, eligibility.body.code, 'the code is minted once, not per request');
    assert.deepEqual(me.body.stats, {
      totalReferrals: 0,
      pending: 0,
      converted: 0,
      rewardsEarned: 0,
      freeDaysEarned: 0
    });
  });

  it('validates a code without a session', async () => {
    const referrer = await seeded();
    const code = await ensureReferralCode(referrer.business._id);

    const ok = await request(app).post('/api/v1/public/referrals/validate').send({ code });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.valid, true);
    assert.equal(ok.body.referrerName, 'Test Business');

    const bad = await request(app).post('/api/v1/public/referrals/validate').send({ code: 'ZZZZZZZZ' });
    assert.equal(bad.body.valid, false);
    assert.equal(bad.body.reason, 'REFERRAL_CODE_INVALID');
  });

  it('applies a code sent with a signup, and still creates the account when the code is wrong', async () => {
    const referrer = await seeded();
    const code = await ensureReferralCode(referrer.business._id);

    const good = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Referred Owner', email: 'referred@billji.local', password: 'password123', referralCode: code });
    assert.equal(good.status, 201, good.text);
    assert.equal(good.body.referral.applied, true);

    const bad = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Other Owner', email: 'other@billji.local', password: 'password123', referralCode: 'ZZZZZZZZ' });
    assert.equal(bad.status, 201, 'a bad code must never cost the user their account');
    assert.equal(bad.body.referral.applied, false);
    assert.equal(bad.body.referral.reason, 'REFERRAL_CODE_INVALID');
  });
});
