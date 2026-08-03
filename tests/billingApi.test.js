import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import { BILLING_CONTRACT_VERSION } from '../src/contracts/billingDto.js';
import { LIMITS } from '../src/constants/entitlements.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { applyPlan, ensureSubscription } from '../src/services/subscriptionService.js';
import { incrementUsage, setUsage } from '../src/services/usageService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const DAY = 24 * 60 * 60 * 1000;

const seeded = async () => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });
  return context;
};

const getSubscription = (token) => request(app).get('/api/v1/billing/subscription').set(authHeader(token));

describe('GET /billing/subscription — the stable DTO', () => {
  it('returns every contracted field', async () => {
    const { token } = await seeded();
    const response = await getSubscription(token);
    assert.equal(response.status, 200, response.text);

    const { subscription } = response.body;
    // The fields the mobile contract promises. A missing one is a breaking change.
    for (const field of [
      'planId',
      'planName',
      'snapshotVersion',
      'subscriptionStatus',
      'renewalDate',
      'expiryDate',
      'gracePeriodEndsAt',
      'usageSummary',
      'remainingLimits'
    ]) {
      assert.ok(field in subscription, `missing contracted field: ${field}`);
    }

    assert.equal(subscription.contractVersion, BILLING_CONTRACT_VERSION);
    assert.equal(subscription.planName, 'BillJi Starter');
    assert.equal(subscription.planKey, 'starter');
    assert.equal(subscription.subscriptionStatus, 'active');
    assert.equal(subscription.snapshotVersion, 1);
    assert.ok(Array.isArray(subscription.usageSummary));
  });

  it('leaks no internal implementation details', async () => {
    const { token } = await seeded();
    const { body } = await getSubscription(token);

    // Provider metadata, sales notes, raw documents and engine mechanics stay server-side.
    for (const leaked of ['provider', 'notes', 'overrides', 'addOns', 'coupon', 'pause', '_id', '__v', 'entitlements', 'business', 'plan']) {
      assert.ok(!(leaked in body.subscription), `DTO leaks internal field: ${leaked}`);
    }
    for (const row of body.subscription.usageSummary) {
      for (const leaked of ['metered', 'periodKey', 'limitAtTime', 'business']) {
        assert.ok(!(leaked in row), `usage row leaks internal field: ${leaked}`);
      }
    }
  });

  it('reports unlimited as null, never as the -1 sentinel', async () => {
    const { business, token } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    await applyPlan({ business, plan: pro, interval: 'year' });

    const { body } = await getSubscription(token);
    assert.equal(body.subscription.limits[LIMITS.documentsPerMonth], null);
    assert.equal(body.subscription.remainingLimits[LIMITS.documentsPerMonth], null);

    const documents = body.subscription.usageSummary.find((row) => row.key === LIMITS.documentsPerMonth);
    assert.equal(documents.limit, null);
    assert.equal(documents.remaining, null);
    assert.equal(documents.unlimited, true);
    // A client must never have to know about the -1 sentinel.
    const numbers = [
      ...Object.values(body.subscription.limits),
      ...Object.values(body.subscription.remainingLimits),
      ...body.subscription.usageSummary.flatMap((row) => [row.limit, row.remaining])
    ];
    assert.ok(!numbers.includes(-1), 'the -1 sentinel must be translated to null');
  });

  it('reports usage and remaining limits', async () => {
    const { business, token } = await seeded();
    await incrementUsage({
      business: business._id,
      entitlements: { features: {}, limits: { documents_per_month: 200 } },
      limitKey: LIMITS.documentsPerMonth,
      amount: 160
    });

    const { body } = await getSubscription(token);
    const documents = body.subscription.usageSummary.find((row) => row.key === LIMITS.documentsPerMonth);

    assert.equal(documents.used, 160);
    assert.equal(documents.limit, 200);
    assert.equal(documents.remaining, 40);
    assert.equal(documents.percentUsed, 80);
    assert.ok(documents.resetsAt, 'a monthly meter must say when it resets');
    assert.equal(body.subscription.remainingLimits[LIMITS.documentsPerMonth], 40);
  });

  it('counts seats live rather than from a meter', async () => {
    const { token } = await seeded();
    const { body } = await getSubscription(token);
    const seats = body.subscription.usageSummary.find((row) => row.key === LIMITS.teamMembers);

    // Starter: 1 seat, the owner is using it.
    assert.equal(seats.used, 1);
    assert.equal(seats.limit, 1);
    assert.equal(seats.remaining, 0);
    assert.equal(seats.resetsAt, null);
  });

  it('surfaces overage so the upgrade prompt has a number', async () => {
    const { business, token } = await seeded();
    const starter = { features: {}, limits: { documents_per_month: 200 } };
    await setUsage({ business: business._id, limitKey: LIMITS.documentsPerMonth, count: 200 });
    await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth, allowOverage: true });

    const { body } = await getSubscription(token);
    const documents = body.subscription.usageSummary.find((row) => row.key === LIMITS.documentsPerMonth);
    assert.equal(documents.overage, 1);
    assert.equal(documents.used, 201);
  });
});

describe('renewal / expiry / grace dates are distinct', () => {
  it('reports all three for a paid plan', async () => {
    const { business, token } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    const now = new Date();
    await applyPlan({ business, plan: pro, interval: 'month', now });

    const { body } = await getSubscription(token);
    const { renewalDate, expiryDate, gracePeriodEndsAt } = body.subscription;

    assert.equal(renewalDate, expiryDate, 'with no cancellation pending, the next charge is when access would end');
    // Pro grants 7 grace days past expiry.
    assert.equal(new Date(gracePeriodEndsAt) - new Date(expiryDate), 7 * DAY);
    assert.equal(body.subscription.billingInterval, 'month');
  });

  it('nulls the renewal date but keeps the expiry when a cancellation is pending', async () => {
    const { business, token } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    await applyPlan({ business, plan: pro, interval: 'month' });

    const subscription = await Subscription.findOne({ business: business._id });
    subscription.cancel = { requestedAt: new Date(), effectiveAt: subscription.currentPeriodEnd, atPeriodEnd: true };
    await subscription.save();

    const { body } = await getSubscription(token);
    assert.equal(body.subscription.renewalDate, null, 'a cancelled subscription will not be charged again');
    assert.ok(body.subscription.expiryDate, 'but access still ends on a known date');
    assert.equal(body.subscription.cancelAtPeriodEnd, true);
    // Access is not gone yet.
    assert.equal(body.subscription.subscriptionStatus, 'active');
  });

  it('nulls every date for a plan that never expires', async () => {
    const { token } = await seeded();
    const { body } = await getSubscription(token);

    assert.equal(body.subscription.renewalDate, null);
    assert.equal(body.subscription.expiryDate, null);
    assert.equal(body.subscription.subscriptionStatus, 'active');
  });

  it('reports in_grace with full entitlements after the period ends', async () => {
    const { business, token } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    await applyPlan({ business, plan: pro, interval: 'month', now: new Date(Date.now() - 32 * DAY) });

    const { body } = await getSubscription(token);
    assert.equal(body.subscription.subscriptionStatus, 'in_grace');
    assert.equal(body.subscription.inGracePeriod, true);
    assert.equal(body.subscription.features.expenses, true, 'a late renewal must not lock a paying customer out');
  });

  it('falls back to the default plan once expired, without locking the customer out', async () => {
    const { business, token } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    await applyPlan({ business, plan: pro, interval: 'month', now: new Date(Date.now() - 90 * DAY) });

    const { body } = await getSubscription(token);
    assert.equal(body.subscription.subscriptionStatus, 'expired');
    assert.equal(body.subscription.planKey, 'starter');
    assert.equal(body.subscription.features.gst_billing, true);
    assert.equal(body.subscription.features.expenses, undefined);
  });
});

describe('GET /billing/usage', () => {
  it('returns the same numbers as the subscription payload', async () => {
    const { business, token } = await seeded();
    await incrementUsage({
      business: business._id,
      entitlements: { features: {}, limits: { documents_per_month: 200 } },
      limitKey: LIMITS.documentsPerMonth,
      amount: 12
    });

    const [usage, subscription] = await Promise.all([
      request(app).get('/api/v1/billing/usage').set(authHeader(token)),
      getSubscription(token)
    ]);

    assert.equal(usage.status, 200, usage.text);
    assert.deepEqual(usage.body.usage.usageSummary, subscription.body.subscription.usageSummary);
    assert.deepEqual(usage.body.usage.remainingLimits, subscription.body.subscription.remainingLimits);
    assert.equal(usage.body.usage.contractVersion, BILLING_CONTRACT_VERSION);
  });
});

describe('GET /billing/plans', () => {
  it('lists only public plans, with the current one marked', async () => {
    const { token } = await seeded();
    const response = await request(app).get('/api/v1/billing/plans').set(authHeader(token));
    assert.equal(response.status, 200, response.text);

    const keys = response.body.plans.map((plan) => plan.planKey);
    assert.deepEqual(keys, ['starter', 'pro', 'business']);
    // Enterprise is assigned by sales; legacy_pro is grandfathering. Neither is ever offered.
    assert.ok(!keys.includes('enterprise'));
    assert.ok(!keys.includes('legacy_pro'));

    const starter = response.body.plans.find((plan) => plan.planKey === 'starter');
    assert.equal(starter.isCurrent, true);
    assert.equal(response.body.plans.filter((plan) => plan.isCurrent).length, 1);
  });

  it('sends prices as integer paise, unformatted', async () => {
    const { token } = await seeded();
    const { body } = await request(app).get('/api/v1/billing/plans').set(authHeader(token));
    const pro = body.plans.find((plan) => plan.planKey === 'pro');

    assert.deepEqual(
      pro.prices.map((price) => [price.interval, price.amount]),
      [['month', 24900], ['year', 199900]]
    );
    assert.equal(pro.prices[0].currency, 'INR');
    assert.equal(pro.trial.days, 14);
  });

  it('exposes plan limits with unlimited as null', async () => {
    const { token } = await seeded();
    const { body } = await request(app).get('/api/v1/billing/plans').set(authHeader(token));
    const business = body.plans.find((plan) => plan.planKey === 'business');

    assert.equal(business.limits[LIMITS.teamMembers], 10);
    // Approved Decision 6.
    assert.equal(business.limits[LIMITS.businesses], null);
  });
});

describe('auth responses carry the same subscription DTO', () => {
  it('includes it on /auth/me', async () => {
    const { token } = await seeded();
    const [me, billing] = await Promise.all([
      request(app).get('/api/v1/auth/me').set(authHeader(token)),
      getSubscription(token)
    ]);

    assert.equal(me.status, 200, me.text);
    assert.deepEqual(me.body.user.subscription, billing.body.subscription, 'one DTO, one shape, everywhere');
  });

  it('provisions a subscription at signup', async () => {
    clearPlanCache();
    await bootstrapBilling();

    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'New Owner', email: 'new-owner@billji.local', password: 'password123' });

    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.user.subscription.planKey, 'starter');
    assert.equal(response.body.user.subscription.subscriptionStatus, 'active');
    assert.equal(await Subscription.countDocuments({ business: response.body.user.businessId }), 1);
  });

  it('still registers when the billing catalog has not been seeded', async () => {
    clearPlanCache();
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Unseeded', email: 'unseeded@billji.local', password: 'password123' });

    // A signup must never fail over billing setup.
    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.user.subscription.subscriptionStatus, 'none');
    assert.deepEqual(response.body.user.subscription.features, {});
  });
});

describe('authorization', () => {
  it('requires a token', async () => {
    const response = await request(app).get('/api/v1/billing/subscription');
    assert.equal(response.status, 401);
  });

  it('lets a viewer see the plan but reports their own seat usage', async () => {
    clearPlanCache();
    await bootstrapBilling();
    const viewer = await createTestContext({ roleKey: 'viewer' });
    await ensureSubscription({ business: viewer.business });

    const response = await getSubscription(viewer.token);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.subscription.planKey, 'starter');
  });
});
