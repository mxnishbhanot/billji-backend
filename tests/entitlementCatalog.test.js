import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_FEATURE_KEYS,
  ALL_LIMIT_KEYS,
  DEFAULT_PLAN_KEY,
  FEATURES,
  LIMITS,
  PLAN_SEEDS,
  UNLIMITED,
  isFeatureKey,
  isLimitKey
} from '../src/constants/entitlements.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Plan from '../src/models/Plan.js';
import { canAccessFeature, getLimit, plansGrantingFeature } from '../src/services/entitlementService.js';
import { useMongoTestDb } from './helpers/db.js';

useMongoTestDb();

describe('entitlement catalog', () => {
  it('exposes immutable snake_case keys with camelCase accessors', () => {
    assert.equal(FEATURES.advancedReports, 'advanced_reports');
    assert.equal(LIMITS.documentsPerMonth, 'documents_per_month');
    // Every key must be snake_case: a renamed key silently revokes access for every existing
    // subscriber whose snapshot holds the old spelling.
    for (const key of [...ALL_FEATURE_KEYS, ...ALL_LIMIT_KEYS]) {
      assert.match(key, /^[a-z][a-z0-9_]*$/, `${key} is not a snake_case key`);
    }
  });

  it('has no duplicate keys', () => {
    assert.equal(new Set(ALL_FEATURE_KEYS).size, ALL_FEATURE_KEYS.length);
    assert.equal(new Set(ALL_LIMIT_KEYS).size, ALL_LIMIT_KEYS.length);
  });

  it('rejects unknown keys', () => {
    assert.ok(isFeatureKey('expenses'));
    assert.ok(!isFeatureKey('Advanced Reports'));
    assert.ok(isLimitKey('documents_per_month'));
    assert.ok(!isLimitKey('documentsPerMonth'));
  });

  it('seeds only keys that exist in the catalog', () => {
    for (const seed of PLAN_SEEDS) {
      for (const key of Object.keys(seed.features)) assert.ok(isFeatureKey(key), `${seed.key} grants unknown feature ${key}`);
      for (const key of Object.keys(seed.limits)) assert.ok(isLimitKey(key), `${seed.key} sets unknown limit ${key}`);
    }
  });

  it('keeps each paid tier a superset of the one below it', () => {
    const featuresOf = (key) => new Set(Object.keys(PLAN_SEEDS.find((plan) => plan.key === key).features));
    const [starter, pro, business] = ['starter', 'pro', 'business'].map(featuresOf);

    for (const key of starter) assert.ok(pro.has(key), `Pro is missing Starter feature ${key}`);
    for (const key of pro) assert.ok(business.has(key), `Business is missing Pro feature ${key}`);
  });

  it('matches the approved plan matrix', () => {
    const seed = (key) => PLAN_SEEDS.find((plan) => plan.key === key);

    assert.equal(seed('starter').limits.documents_per_month, 200);
    assert.equal(seed('starter').limits.team_members, 1);
    assert.equal(seed('starter').limits.businesses, 1);
    assert.equal(seed('starter').prices[0].amount, 0);

    assert.equal(seed('pro').limits.documents_per_month, UNLIMITED);
    assert.equal(seed('pro').limits.team_members, 1);
    assert.equal(seed('pro').limits.businesses, 1);
    // Paise, not rupees.
    assert.equal(seed('pro').prices.find((price) => price.interval === 'month').amount, 24900);
    assert.equal(seed('pro').prices.find((price) => price.interval === 'year').amount, 199900);

    assert.equal(seed('business').limits.team_members, 10);
    // Approved Decision 6: unlimited businesses, and the ceiling lives in data either way.
    assert.equal(seed('business').limits.businesses, UNLIMITED);
    assert.equal(seed('business').prices.find((price) => price.interval === 'month').amount, 49900);
    assert.equal(seed('business').prices.find((price) => price.interval === 'year').amount, 499900);

    // Enterprise and grandfathering plans are never listed to customers.
    assert.equal(seed('enterprise').visibility, 'private');
    assert.equal(seed('legacy_pro').visibility, 'private');
    assert.equal(seed('legacy_pro').prices[0].amount, 0);
    assert.equal(seed('legacy_pro').prices[0].interval, 'lifetime');
  });

  it('names exactly one default plan', () => {
    const defaults = PLAN_SEEDS.filter((plan) => plan.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].key, DEFAULT_PLAN_KEY);
  });
});

describe('plan seeding', () => {
  it('is idempotent and does not stomp admin edits', async () => {
    const first = await bootstrapBilling();
    assert.equal(first.created.length, PLAN_SEEDS.length);

    // An admin drops the Pro monthly price and removes a feature.
    const pro = await Plan.findOne({ key: 'pro' });
    pro.prices = pro.prices.filter((price) => price.interval !== 'month');
    pro.features.delete('expenses');
    pro.name = 'Pro (renamed by admin)';
    await pro.save();

    const second = await bootstrapBilling();
    assert.equal(second.created.length, 0, 're-seeding must not duplicate plans');
    assert.equal(await Plan.countDocuments(), PLAN_SEEDS.length);

    const afterReseed = await Plan.findOne({ key: 'pro' });
    // Entitlements and prices are the admin's; only presentation is refreshed from the catalog.
    assert.equal(afterReseed.prices.some((price) => price.interval === 'month'), false);
    assert.equal(afterReseed.features.get('expenses'), undefined);
    assert.equal(afterReseed.name, 'BillJi Pro');
  });

  it('force-reseeds catalog values and bumps the version', async () => {
    await bootstrapBilling();
    const before = await Plan.findOne({ key: 'pro' });
    before.features.delete('expenses');
    await before.save();

    await bootstrapBilling({ force: true });
    const after = await Plan.findOne({ key: 'pro' });
    assert.equal(after.features.get('expenses'), true);
    assert.equal(after.version, before.version + 1);
  });

  it('refuses a plan carrying an unknown entitlement key', async () => {
    await assert.rejects(
      Plan.create({ key: 'typo', name: 'Typo', features: { advanced_report: true } }),
      /Unknown entitlement keys/
    );
  });

  it('allows only one default plan', async () => {
    await bootstrapBilling();
    await assert.rejects(Plan.create({ key: 'second-default', name: 'Second', isDefault: true }), /E11000/);
  });

  it('resolves the cheapest plans granting a feature instead of hardcoding a plan name', async () => {
    await bootstrapBilling();
    const granting = await plansGrantingFeature(FEATURES.expenses);

    assert.deepEqual(granting.map((plan) => plan.planKey), ['pro', 'business']);
    // Private plans are never offered as an upgrade target.
    assert.ok(!granting.some((plan) => plan.planKey === 'enterprise'));
  });
});

describe('feature + limit readers', () => {
  const entitlements = { features: { expenses: true, teams: false }, limits: { documents_per_month: 200 } };

  it('reads features by key only', () => {
    assert.equal(canAccessFeature(entitlements, FEATURES.expenses), true);
    assert.equal(canAccessFeature(entitlements, FEATURES.teams), false);
    // Absent means denied.
    assert.equal(canAccessFeature(entitlements, FEATURES.apiAccess), false);
  });

  it('throws on a typo rather than silently denying', () => {
    assert.throws(() => canAccessFeature(entitlements, 'expense'), /Unknown feature key/);
    assert.throws(() => getLimit(entitlements, 'documents'), /Unknown limit key/);
  });

  it('treats an absent limit as no ceiling', () => {
    assert.equal(getLimit(entitlements, LIMITS.documentsPerMonth), 200);
    // A newly added limit key must never block anyone by surprise.
    assert.equal(getLimit(entitlements, LIMITS.storageBytes), UNLIMITED);
  });
});
