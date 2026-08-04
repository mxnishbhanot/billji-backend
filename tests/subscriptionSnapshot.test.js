import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import { FEATURES, LIMITS, UNLIMITED } from '../src/constants/entitlements.js';
import Business from '../src/models/Business.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionHistory from '../src/models/SubscriptionHistory.js';
import { canAccessFeature, clearPlanCache, getLimit } from '../src/services/entitlementService.js';
import { applyPlan, buildSnapshot, ensureSubscription, resnapshot, resolveAccess, resolveStatus } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const seeded = async () => {
  clearPlanCache();
  await bootstrapBilling();
  return createTestContext();
};

const DAY = 24 * 60 * 60 * 1000;

describe('subscription creation', () => {
  it('puts a new business on the default plan with a snapshot', async () => {
    const { business } = await seeded();
    const subscription = await ensureSubscription({ business });

    assert.equal(subscription.planKey, 'starter');
    assert.equal(subscription.entitlements.features.get('gst_billing'), true);
    assert.equal(subscription.entitlements.limits.get('documents_per_month'), 200);
    // Free plans never expire.
    assert.equal(subscription.currentPeriodEnd, null);
    assert.equal(subscription.billingInterval, 'free');
  });

  it('is idempotent', async () => {
    const { business } = await seeded();
    const first = await ensureSubscription({ business });
    const second = await ensureSubscription({ business });

    assert.equal(String(first._id), String(second._id));
    assert.equal(await Subscription.countDocuments({ business: business._id }), 1);
  });

  it('mirrors the plan onto the business for legacy readers', async () => {
    const { business } = await seeded();
    await ensureSubscription({ business });

    const reloaded = await Business.findById(business._id);
    assert.equal(reloaded.plan.key, 'starter');
    assert.equal(reloaded.plan.subscriptionStatus, 'active');
  });

  it('records a history row', async () => {
    const { business } = await seeded();
    await ensureSubscription({ business });

    const history = await SubscriptionHistory.find({ business: business._id });
    assert.equal(history.length, 1);
    assert.equal(history[0].action, 'created');
    assert.equal(history[0].toPlanKey, 'starter');
    assert.equal(history[0].snapshotAfter.limits.get('documents_per_month'), 200);
  });

  it('refuses to create a subscription with no plans seeded', async () => {
    clearPlanCache();
    const { business } = await createTestContext();
    await assert.rejects(ensureSubscription({ business }), /Run the billing seeder/);
  });
});

describe('the snapshot is a copy, not a reference', () => {
  it('does not change an existing subscriber when the plan is edited', async () => {
    const { business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    const subscription = await applyPlan({ business, plan: pro, interval: 'year' });

    assert.equal(canAccessFeature({ features: Object.fromEntries(subscription.entitlements.features) }, FEATURES.expenses), true);

    // The admin strips expenses out of Pro and halves the document allowance.
    pro.features.set('expenses', false);
    pro.limits.set('documents_per_month', 50);
    pro.version += 1;
    await pro.save();
    clearPlanCache();

    const access = await resolveAccess({ business });
    // This is the guarantee the whole design rests on.
    assert.equal(canAccessFeature(access.entitlements, FEATURES.expenses), true, 'a paid subscriber must keep what they bought');
    assert.equal(getLimit(access.entitlements, LIMITS.documentsPerMonth), UNLIMITED);
  });

  it('adopts the new plan only on an explicit resnapshot', async () => {
    const { business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    await applyPlan({ business, plan: pro, interval: 'year' });

    pro.features.set('expenses', false);
    pro.version += 1;
    await pro.save();

    const subscription = await Subscription.findOne({ business: business._id });
    await resnapshot({ subscription });

    const access = await resolveAccess({ business });
    assert.equal(canAccessFeature(access.entitlements, FEATURES.expenses), false);
    assert.equal(access.subscription.planVersion, pro.version);

    const history = await SubscriptionHistory.findOne({ business: business._id, action: 'resnapshot' });
    assert.ok(history, 'a resnapshot must be auditable');
    assert.equal(history.snapshotBefore.features.get('expenses'), true);
  });

  it('snapshots plain values, not live plan handles', () => {
    const snapshot = buildSnapshot({ features: new Map([['expenses', true]]), limits: new Map([['team_members', 5]]) });
    assert.deepEqual(snapshot, { features: { expenses: true }, limits: { team_members: 5 } });
  });
});

describe('period + pricing', () => {
  it('computes the period end itself from the interval', async () => {
    const { business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    const now = new Date('2026-03-15T10:00:00.000Z');

    const monthly = await applyPlan({ business, plan: pro, interval: 'month', now });
    assert.equal(monthly.currentPeriodEnd.toISOString(), new Date('2026-04-15T10:00:00.000Z').toISOString());
    // Pro grants 7 grace days on top.
    assert.equal(monthly.graceEndsAt.toISOString(), new Date('2026-04-22T10:00:00.000Z').toISOString());

    const yearly = await applyPlan({ business, plan: pro, interval: 'year', now });
    assert.equal(yearly.currentPeriodEnd.toISOString(), new Date('2027-03-15T10:00:00.000Z').toISOString());
    assert.equal(yearly.pricing.amount, 199900);
  });

  it('keeps a locked price across a renewal even after a price rise', async () => {
    const { business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    await applyPlan({ business, plan: pro, interval: 'year', amount: 149900, lockPricing: true });

    pro.prices.find((price) => price.interval === 'year').amount = 299900;
    await pro.save();

    const renewed = await applyPlan({ business, plan: pro, interval: 'year', action: 'renewed' });
    assert.equal(renewed.pricing.amount, 149900, 'founding-member pricing must survive a renewal');
    assert.equal(renewed.pricing.locked, true);
  });

  it('grandfathers onto legacy_pro with Pro entitlements, no cost and no expiry', async () => {
    const { business } = await seeded();
    const legacy = await Plan.findOne({ key: 'legacy_pro' });
    const subscription = await applyPlan({ business, plan: legacy, lockPricing: true, actor: { type: 'system', note: 'backfill' } });

    assert.equal(subscription.currentPeriodEnd, null);
    assert.equal(subscription.pricing.amount, 0);
    assert.equal(subscription.pricing.locked, true);
    assert.equal(resolveStatus(subscription), 'active');

    const access = await resolveAccess({ business });
    assert.equal(canAccessFeature(access.entitlements, FEATURES.expenses), true);
    assert.equal(canAccessFeature(access.entitlements, FEATURES.advancedReports), true);
    // legacy_pro is Pro, not Business.
    assert.equal(canAccessFeature(access.entitlements, FEATURES.teams), false);
  });
});

describe('status resolution is computed from dates, never read from the stored field', () => {
  const base = { status: 'active', currentPeriodEnd: null, graceEndsAt: null, trial: {}, cancel: {} };
  const now = new Date('2026-06-15T00:00:00.000Z');

  it('treats a null period end as never expiring', () => {
    assert.equal(resolveStatus({ ...base }, now), 'active');
  });

  it('expires the instant the period ends, with no job involved', () => {
    const endsAt = new Date('2026-06-14T23:59:59.000Z');
    // Stored status still says active — reality says otherwise.
    assert.equal(resolveStatus({ ...base, currentPeriodEnd: endsAt, graceEndsAt: endsAt }, now), 'expired');
  });

  it('honours the grace window', () => {
    const endsAt = new Date(now.getTime() - DAY);
    assert.equal(resolveStatus({ ...base, currentPeriodEnd: endsAt, graceEndsAt: new Date(now.getTime() + DAY) }, now), 'in_grace');
  });

  it('keeps a trial until it ends, then expires it', () => {
    const trialing = { ...base, status: 'trialing', trial: { endsAt: new Date(now.getTime() + DAY) } };
    assert.equal(resolveStatus(trialing, now), 'trialing');
    assert.equal(resolveStatus({ ...trialing, trial: { endsAt: new Date(now.getTime() - 1) } }, now), 'expired');
  });

  it('keeps access until a cancellation takes effect', () => {
    const periodEnd = new Date(now.getTime() + 10 * DAY);
    const cancelled = { ...base, currentPeriodEnd: periodEnd, cancel: { effectiveAt: periodEnd } };
    assert.equal(resolveStatus(cancelled, now), 'active');
    assert.equal(resolveStatus(cancelled, new Date(periodEnd.getTime() + 1)), 'cancelled');
  });

  it('reports paused without implementing pause', () => {
    assert.equal(resolveStatus({ ...base, status: 'paused' }, now), 'paused');
  });
});

describe('expired access falls back to the default plan, never to nothing', () => {
  it('gives a lapsed customer Starter rather than locking them out', async () => {
    const { business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    const past = new Date(Date.now() - 90 * DAY);
    await applyPlan({ business, plan: pro, interval: 'month', now: past });

    const access = await resolveAccess({ business });
    assert.equal(access.status, 'expired');
    assert.equal(access.planKey, 'starter');
    // Their own invoices stay reachable...
    assert.equal(canAccessFeature(access.entitlements, FEATURES.gstBilling), true);
    // ...but the paid features are gone.
    assert.equal(canAccessFeature(access.entitlements, FEATURES.expenses), false);
    assert.equal(getLimit(access.entitlements, LIMITS.documentsPerMonth), 200);
  });

  it('keeps full entitlements during grace', async () => {
    const { business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    // Period ended 2 days ago; Pro grants 7 grace days.
    await applyPlan({ business, plan: pro, interval: 'month', now: new Date(Date.now() - 32 * DAY) });

    const access = await resolveAccess({ business });
    assert.equal(access.status, 'in_grace');
    assert.equal(canAccessFeature(access.entitlements, FEATURES.expenses), true, 'a late renewal must not lock a paying customer out');
  });

  it('falls back to Starter for a business with no subscription at all', async () => {
    const { business } = await seeded();
    const access = await resolveAccess({ business });

    assert.equal(access.status, 'none');
    assert.equal(access.planKey, 'starter');
    assert.equal(getLimit(access.entitlements, LIMITS.documentsPerMonth), 200);
  });
});

describe('per-customer overrides', () => {
  it('let Enterprise be tuned without minting a plan row per customer', async () => {
    const { business } = await seeded();
    const enterprise = await Plan.findOne({ key: 'enterprise' });
    await applyPlan({ business, plan: enterprise, interval: 'custom', periodEnd: null });

    const subscription = await Subscription.findOne({ business: business._id });
    subscription.overrides.limits.set('team_members', 250);
    subscription.overrides.features.set('api_access', false);
    await subscription.save();

    const access = await resolveAccess({ business });
    // Override beats the snapshot in both directions.
    assert.equal(getLimit(access.entitlements, LIMITS.teamMembers), 250);
    assert.equal(canAccessFeature(access.entitlements, FEATURES.apiAccess), false);
    assert.equal(canAccessFeature(access.entitlements, FEATURES.dedicatedSupport), true);
  });

  it('refuses an override with an unknown key', async () => {
    const { business } = await seeded();
    const subscription = await ensureSubscription({ business });
    subscription.overrides.limits.set('team_seats', 5);

    await assert.rejects(subscription.save(), /Unknown entitlement keys/);
  });
});

describe('add-on merge shape (schema only, no add-on logic exists)', () => {
  it('adds numeric grants onto the snapshot ceiling', async () => {
    const { business } = await seeded();
    const business_ = await Plan.findOne({ key: 'business' });
    await applyPlan({ business, plan: business_, interval: 'year' });

    const subscription = await Subscription.findOne({ business: business._id });
    subscription.addOns.push({ addOnKey: 'extra_seats', quantity: 3, grants: { limits: { team_members: 5 } } });
    await subscription.save();

    const access = await resolveAccess({ business });
    // 10 from the plan + 3 x 5 from the add-on. Proves selling extra seats needs no migration.
    assert.equal(getLimit(access.entitlements, LIMITS.teamMembers), 25);
  });

  it('ignores an expired add-on', async () => {
    const { business } = await seeded();
    const plan = await Plan.findOne({ key: 'business' });
    await applyPlan({ business, plan, interval: 'year' });

    const subscription = await Subscription.findOne({ business: business._id });
    subscription.addOns.push({
      addOnKey: 'extra_seats',
      quantity: 1,
      grants: { limits: { team_members: 5 } },
      expiresAt: new Date(Date.now() - DAY)
    });
    await subscription.save();

    const access = await resolveAccess({ business });
    assert.equal(getLimit(access.entitlements, LIMITS.teamMembers), 10);
  });
});
