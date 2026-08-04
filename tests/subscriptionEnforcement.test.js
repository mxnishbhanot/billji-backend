import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import { LEGACY_PLAN_KEY, LIMITS } from '../src/constants/entitlements.js';
import AuditLog from '../src/models/AuditLog.js';
import BusinessInvitation from '../src/models/BusinessInvitation.js';
import Expense from '../src/models/Expense.js';
import Invoice from '../src/models/Invoice.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionUsage from '../src/models/SubscriptionUsage.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { applyPlan, ensureSubscription } from '../src/services/subscriptionService.js';
import { enforcementMode } from '../src/middlewares/entitlement.js';
import { ALL_TIME, periodKeyFor } from '../src/services/usageService.js';
import { SYNC_DEVICE_HEADER, SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION } from '../src/modules/sync/protocol.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext, invoicePayload } from './helpers/fixtures.js';

/**
 * Phase 4 — subscription enforcement.
 *
 * Three modes, one rule that outranks all of them: a document created offline is already in a
 * customer's hands, so sync counts it and warns. It never refuses it.
 */

process.env.SYNC_SAFETY_LAG_MS = '0';

useMongoTestDb();

const api = () => request(app);

const setMode = (mode) => {
  process.env.BILLING_ENFORCEMENT = mode;
};

afterEach(() => {
  delete process.env.BILLING_ENFORCEMENT;
});

/** A business on a seeded plan, with the plan cache cleared so the fallback plan is fresh. */
const businessOn = async (planKey = 'starter') => {
  clearPlanCache();
  await bootstrapBilling();
  const owner = await createTestContext();
  const plan = await Plan.findOne({ key: planKey });
  await applyPlan({ business: owner.business._id, plan });
  return owner;
};

const setLimit = (business, limitKey, value) =>
  Subscription.updateOne({ business: business._id }, { $set: { [`overrides.limits.${limitKey}`]: value } });

const documentUsage = (business) =>
  SubscriptionUsage.findOne({ business: business._id, metric: LIMITS.documentsPerMonth });

// Unique phone/sku per call: the same business cannot hold two customers on one number, and a
// test that issues several documents would otherwise fail on the uniqueness index, not the quota.
let fixtureCounter = 0;

const createInvoice = async (owner) => {
  fixtureCounter += 1;
  const customer = await createCustomer(owner.business, { phone: `98765${String(10000 + fixtureCounter)}` });
  const product = await createProduct(owner.business, { name: `Product ${fixtureCounter}` });
  return api()
    .post('/api/v1/invoices')
    .set(authHeader(owner.token))
    .send(invoicePayload({ customer, product, allowOversell: true }));
};

const listExpenses = (owner) => api().get('/api/v1/expenses').set(authHeader(owner.token));

// --- mode resolution --------------------------------------------------------

describe('enforcement mode', () => {
  it('reads off, warn and on, and treats anything else as off', () => {
    setMode('warn');
    assert.equal(enforcementMode(), 'warn');
    setMode('ON');
    assert.equal(enforcementMode(), 'on');
    setMode('yes-please');
    assert.equal(enforcementMode(), 'off');
    delete process.env.BILLING_ENFORCEMENT;
    assert.equal(enforcementMode(), 'off');
  });
});

// --- feature access ---------------------------------------------------------

describe('feature access', () => {
  it('off mode never blocks and never warns', async () => {
    const owner = await businessOn('starter');
    setMode('off');

    const response = await listExpenses(owner);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.billingWarnings, undefined);
  });

  it('warn mode allows the request and returns warning metadata with upgrade options', async () => {
    const owner = await businessOn('starter');
    setMode('warn');

    const response = await listExpenses(owner);
    assert.equal(response.status, 200, response.text);
    const [warning] = response.body.billingWarnings;
    assert.equal(warning.code, 'FEATURE_NOT_IN_PLAN');
    assert.equal(warning.feature, 'expenses');
    assert.equal(warning.currentPlan, 'starter');
    // Computed by scanning plans, never a hardcoded "requires Pro".
    assert.ok(warning.requiredPlans.some((plan) => plan.planKey === 'pro'));
  });

  it('on mode refuses with 402 and the cheapest plans that grant it', async () => {
    const owner = await businessOn('starter');
    setMode('on');

    const response = await listExpenses(owner);
    assert.equal(response.status, 402, response.text);
    assert.equal(response.body.details.code, 'FEATURE_NOT_IN_PLAN');
    assert.ok(response.body.details.requiredPlans.length > 0);
  });

  it('lets a plan that includes the feature through in on mode', async () => {
    const owner = await businessOn('pro');
    setMode('on');

    const response = await listExpenses(owner);
    assert.equal(response.status, 200, response.text);
  });

  it('keeps permission ahead of plan: a viewer is refused for being a viewer', async () => {
    clearPlanCache();
    await bootstrapBilling();
    const viewer = await createTestContext({ roleKey: 'staff' });
    const plan = await Plan.findOne({ key: 'starter' });
    await applyPlan({ business: viewer.business._id, plan });
    setMode('on');

    // staff holds no expenses permission at all, so this is a 403 and never a paywall.
    const response = await listExpenses(viewer);
    assert.equal(response.status, 403, response.text);
    assert.equal(response.body.details.code, 'FORBIDDEN_PERMISSION');
  });
});

// --- usage limits -----------------------------------------------------------

describe('monthly document limit', () => {
  it('on mode refuses the document past the ceiling and does not consume quota for it', async () => {
    const owner = await businessOn('starter');
    await setLimit(owner.business, LIMITS.documentsPerMonth, 1);
    setMode('on');

    const first = await createInvoice(owner);
    assert.equal(first.status, 201, first.text);

    const second = await createInvoice(owner);
    assert.equal(second.status, 402, second.text);
    assert.equal(second.body.details.code, 'LIMIT_REACHED');
    assert.equal(second.body.details.limit, 1);

    assert.equal(await Invoice.countDocuments({ business: owner.business._id }), 1);
    const usage = await documentUsage(owner.business);
    assert.equal(usage.count, 1);
    assert.equal(usage.overage, 0);
  });

  it('warn mode issues the document, records the overage and warns', async () => {
    const owner = await businessOn('starter');
    await setLimit(owner.business, LIMITS.documentsPerMonth, 1);
    setMode('warn');

    assert.equal((await createInvoice(owner)).status, 201);
    const second = await createInvoice(owner);
    assert.equal(second.status, 201, second.text);

    const [warning] = second.body.billingWarnings;
    assert.equal(warning.code, 'LIMIT_EXCEEDED');
    assert.equal(warning.metric, LIMITS.documentsPerMonth);

    const usage = await documentUsage(owner.business);
    assert.equal(usage.count, 2);
    assert.equal(usage.overage, 1);
  });

  it('off mode still counts, so the meters are honest before enforcement is switched on', async () => {
    const owner = await businessOn('starter');
    await setLimit(owner.business, LIMITS.documentsPerMonth, 1);
    setMode('off');

    assert.equal((await createInvoice(owner)).status, 201);
    const second = await createInvoice(owner);
    assert.equal(second.status, 201, second.text);
    assert.equal(second.body.billingWarnings, undefined);

    const usage = await documentUsage(owner.business);
    assert.equal(usage.count, 2);
    assert.equal(usage.overage, 1);
  });

  it('gives the quota back when the document was not created', async () => {
    const owner = await businessOn('starter');
    setMode('on');

    const product = await createProduct(owner.business);
    const failed = await api()
      .post('/api/v1/invoices')
      .set(authHeader(owner.token))
      // A customer id that belongs to nobody: the workflow throws after the quota was charged.
      .send(invoicePayload({ customer: { _id: owner.business._id }, product, allowOversell: true }));

    assert.ok(failed.status >= 400, failed.text);
    const usage = await documentUsage(owner.business);
    assert.equal(usage?.count ?? 0, 0);
  });

  it('refuses the very first document on a zero ceiling, and counts nothing for it', async () => {
    const owner = await businessOn('starter');
    await setLimit(owner.business, LIMITS.documentsPerMonth, 0);
    setMode('on');

    const response = await createInvoice(owner);
    assert.equal(response.status, 402, response.text);
    assert.equal(response.body.details.code, 'LIMIT_REACHED');
    assert.equal(await Invoice.countDocuments({ business: owner.business._id }), 0);
    assert.equal((await documentUsage(owner.business))?.count ?? 0, 0);
  });

  it('never charges the quota twice for one document', async () => {
    const owner = await businessOn('pro');
    setMode('on');

    assert.equal((await createInvoice(owner)).status, 201);
    const usage = await documentUsage(owner.business);
    assert.equal(usage.count, 1);
  });
});

describe('team member limit', () => {
  const invite = (owner, email) =>
    api().post('/api/v1/team/invitations').set(authHeader(owner.token)).send({ email, roleKey: 'staff' });

  it('on mode answers the billing envelope once the seats are gone', async () => {
    const owner = await businessOn('business'); // teams feature, 10 seats
    await setLimit(owner.business, LIMITS.teamMembers, 1); // owner already occupies it
    setMode('on');

    const response = await invite(owner, 'seat@billji.local');
    assert.equal(response.status, 402, response.text);
    assert.equal(response.body.details.code, 'LIMIT_REACHED');
    assert.equal(response.body.details.metric, LIMITS.teamMembers);
  });

  // REGRESSION (audit P1-3). Warn mode used to let the invite through, which made the rollout's own
  // observation window a seat-cap bypass: the one limit that existed before billing stopped being
  // enforced the moment you switched enforcement from `off` to `warn`. Warn may only ADD a warning.
  it('warn mode still refuses the invite — warn never weakens a rule that already held', async () => {
    const owner = await businessOn('business');
    await setLimit(owner.business, LIMITS.teamMembers, 1);
    setMode('warn');

    const response = await invite(owner, 'seat@billji.local');
    assert.equal(response.status, 403, response.text);
    assert.equal(response.body.details.code, 'MEMBER_LIMIT_REACHED');
    assert.equal(await BusinessInvitation.countDocuments({ business: owner.business._id }), 0, 'no seat was handed out');
    // The analytics warn mode exists for is still recorded.
    const warned = await AuditLog.findOne({ business: owner.business._id, action: 'billing.limit.warned' });
    assert.ok(warned, 'warn mode records what on mode would have blocked');
    assert.equal(warned.metadata.metric, LIMITS.teamMembers);
  });

  it('off mode keeps the pre-billing 403, so the one existing cap does not loosen', async () => {
    const owner = await businessOn('business');
    await setLimit(owner.business, LIMITS.teamMembers, 1);
    setMode('off');

    const response = await invite(owner, 'seat@billji.local');
    assert.equal(response.status, 403, response.text);
    assert.equal(response.body.details.code, 'MEMBER_LIMIT_REACHED');
  });

  it('gates growing the team on the feature but never shrinking it', async () => {
    const owner = await businessOn('starter'); // no teams feature
    setMode('on');

    const invited = await invite(owner, 'nope@billji.local');
    assert.equal(invited.status, 402, invited.text);
    assert.equal(invited.body.details.feature, 'teams');

    // Reads stay open: a downgraded business must still see who has access.
    const members = await api().get('/api/v1/team/members').set(authHeader(owner.token));
    assert.equal(members.status, 200, members.text);
  });
});

// --- lapsing mid-month ------------------------------------------------------
//
// REGRESSION (audit P1-8). Usage is counted even on an unlimited plan, so a Pro business that issued
// thousands of documents this month and then lapsed inherited the free plan's 200 ceiling with
// thousands already in the counter: enforcement refused the very next document and kept refusing until
// the 1st. The free ceiling governs free-plan usage, so free-plan usage is what it counts now — a
// separate bucket for the same month.

describe('a subscription that lapses mid-month', () => {
  const expire = (business) =>
    Subscription.updateOne(
      { business: business._id },
      { $set: { currentPeriodEnd: new Date(Date.now() - 60_000), graceEndsAt: new Date(Date.now() - 30_000) } }
    );

  // The fallback ceiling comes from the default PLAN, not from subscription overrides: an unentitled
  // business reads the plan, so its overrides are deliberately ignored.
  const setDefaultPlanLimit = async (value) => {
    await Plan.updateOne({ key: 'starter' }, { $set: { [`limits.${LIMITS.documentsPerMonth}`]: value } });
    clearPlanCache();
  };

  const usageRows = (business) =>
    SubscriptionUsage.find({ business: business._id, metric: LIMITS.documentsPerMonth }).sort({ periodKey: 1 }).lean();

  it('still lets the business bill after it lapses, instead of refusing until the 1st', async () => {
    const owner = await businessOn('pro'); // unlimited documents
    setMode('on');
    assert.equal((await createInvoice(owner)).status, 201);
    assert.equal((await createInvoice(owner)).status, 201);

    await expire(owner.business);
    await setDefaultPlanLimit(1);

    // Two documents already sit in this month's paid counter, and the free ceiling is one. Before the
    // fix this was a 402 on the very next document.
    assert.equal((await createInvoice(owner)).status, 201);

    const rows = await usageRows(owner.business);
    assert.equal(rows.length, 2, 'paid usage and fallback usage are separate rows for the same month');
    const [paid, lapsed] = rows;
    assert.equal(paid.count, 2);
    assert.equal(lapsed.count, 1);
    assert.match(lapsed.periodKey, /:f$/);
  });

  it('still enforces the free ceiling once the fallback allowance is spent', async () => {
    const owner = await businessOn('pro');
    setMode('on');
    assert.equal((await createInvoice(owner)).status, 201);

    await expire(owner.business);
    await setDefaultPlanLimit(1);

    assert.equal((await createInvoice(owner)).status, 201, 'the one free document');
    const refused = await createInvoice(owner);
    assert.equal(refused.status, 402, refused.text);
    assert.equal(refused.body.details.code, 'LIMIT_REACHED');
  });

  it('reports the fallback allowance on the meter, not the paid month against a free ceiling', async () => {
    const owner = await businessOn('pro');
    setMode('on');
    assert.equal((await createInvoice(owner)).status, 201);
    assert.equal((await createInvoice(owner)).status, 201);

    await expire(owner.business);
    await setDefaultPlanLimit(200);

    const { body } = await api().get('/api/v1/billing/usage').set(authHeader(owner.token));
    const row = body.usage.usageSummary.find((entry) => entry.key === LIMITS.documentsPerMonth);

    assert.equal(row.limit, 200);
    assert.equal(row.used, 0, 'none of the paid documents were free-plan documents');
    assert.equal(row.percentUsed, 0);
  });

  it('returns to the paid counter on renewal, keeping the month it already counted', async () => {
    const owner = await businessOn('pro');
    setMode('on');
    assert.equal((await createInvoice(owner)).status, 201);

    await expire(owner.business);
    await setDefaultPlanLimit(1);
    assert.equal((await createInvoice(owner)).status, 201);

    // Renewed: entitled again, so the paid bucket resumes from where it was.
    await applyPlan({ business: owner.business._id, plan: await Plan.findOne({ key: 'pro' }), interval: 'month', action: 'renewed' });
    assert.equal((await createInvoice(owner)).status, 201);

    const rows = await usageRows(owner.business);
    const paid = rows.find((row) => !row.periodKey.endsWith(':f'));
    const lapsed = rows.find((row) => row.periodKey.endsWith(':f'));
    assert.equal(paid.count, 2, 'the paid counter continued rather than restarting');
    assert.equal(lapsed.count, 1, 'the lapsed month is left as history');
  });

  it('gives a released unit back to the bucket it came from', async () => {
    const owner = await businessOn('pro');
    setMode('on');
    await expire(owner.business);
    await setDefaultPlanLimit(5);

    // A create that fails after the quota was consumed: an unknown customer.
    const failed = await api()
      .post('/api/v1/invoices')
      .set(authHeader(owner.token))
      .send({ customerId: '6a0000000000000000000000', items: [], taxRate: 0, discountType: 'flat', discountValue: 0 });
    assert.ok(failed.status >= 400, failed.text);

    const rows = await usageRows(owner.business);
    assert.equal(rows.reduce((total, row) => total + row.count, 0), 0, 'nothing left consumed in either bucket');
  });

  it('does not split an all-time metered limit, which is a stock and not a monthly flow', async () => {
    const owner = await businessOn('pro');
    await expire(owner.business);

    assert.equal(periodKeyFor(LIMITS.storageBytes, new Date(), { fallback: true }), ALL_TIME);
    assert.equal(periodKeyFor(LIMITS.documentsPerMonth, new Date(), { fallback: true }).endsWith(':f'), true);
  });
});

// --- the sync registry ------------------------------------------------------

describe('sync push enforcement', () => {
  const syncHeaders = (token, deviceId = 'device-enforce-1') => ({
    ...authHeader(token),
    [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION),
    [SYNC_DEVICE_HEADER]: deviceId
  });

  const push = (owner, ops) => api().post('/api/v1/sync/push').set(syncHeaders(owner.token)).send({ ops });

  const expenseOp = (opId = 'op-expense-1') => ({
    opId,
    entity: 'expense',
    opType: 'create',
    clientId: opId,
    payload: { category: 'rent', amount: 500, paymentMethod: 'cash', date: new Date().toISOString() }
  });

  const invoiceOp = async (owner, opId) => {
    fixtureCounter += 1;
    const customer = await createCustomer(owner.business, { phone: `98765${String(10000 + fixtureCounter)}` });
    const product = await createProduct(owner.business, { name: `Product ${fixtureCounter}` });
    return {
      opId,
      entity: 'invoice',
      opType: 'create',
      clientId: opId,
      payload: {
        customerId: String(customer._id),
        items: [{ productId: String(product._id), quantity: 1 }],
        taxRate: 0,
        discountType: 'flat',
        discountValue: 0,
        allowOversell: true
      }
    };
  };

  // REGRESSION (audit P1-9). This used to answer 402 and reject the operation, which stranded the
  // record: it existed on the device, could never sync, and was lost at the next reinstall. The
  // offline rule that already protected documents against a LIMIT now protects any offline record
  // against a FEATURE gate too — accepted, flagged, never refused.
  it('accepts an offline record for a feature the plan lacks, rather than stranding it', async () => {
    const owner = await businessOn('starter'); // no expenses feature
    setMode('on');

    const response = await push(owner, [expenseOp()]);
    assert.equal(response.status, 200, response.text);
    const [result] = response.body.results;
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.warnings[0].code, 'FEATURE_NOT_IN_PLAN_OFFLINE');
    assert.equal(result.warnings[0].feature, 'expenses');
    assert.ok(result.warnings[0].requiredPlans.length, 'the upgrade prompt knows what to offer');

    // The record is really there, not just acknowledged.
    assert.equal(await Expense.countDocuments({ business: owner.business._id }), 1);
    // And it is visible to ops rather than silently allowed.
    const audited = await AuditLog.findOne({ business: owner.business._id, action: 'billing.feature.overage_offline' });
    assert.ok(audited);
    assert.equal(audited.metadata.feature, 'expenses');
  });

  it('still refuses the same feature on the online route — only the offline path is exempt', async () => {
    const owner = await businessOn('starter');
    setMode('on');

    const online = await api()
      .post('/api/v1/expenses')
      .set(authHeader(owner.token))
      .send({ category: 'rent', amount: 500, paymentMethod: 'cash', date: new Date().toISOString() });

    assert.equal(online.status, 402, online.text);
    assert.equal(online.body.details.code, 'FEATURE_NOT_IN_PLAN');
  });

  it('warns per operation in warn mode instead of failing it', async () => {
    const owner = await businessOn('starter');
    setMode('warn');

    const response = await push(owner, [expenseOp('op-expense-warn')]);
    const [result] = response.body.results;
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.warnings[0].code, 'FEATURE_NOT_IN_PLAN_OFFLINE');
  });

  it('lets a plan that includes the feature push normally', async () => {
    const owner = await businessOn('pro');
    setMode('on');

    const response = await push(owner, [expenseOp('op-expense-pro')]);
    assert.equal(response.body.results[0].status, 'ok', response.text);
  });

  it('NEVER rejects an already-issued offline document for a plan limit, even in on mode', async () => {
    const owner = await businessOn('starter');
    await setLimit(owner.business, LIMITS.documentsPerMonth, 1);
    setMode('on');

    // The ceiling is already used up by an online document.
    assert.equal((await createInvoice(owner)).status, 201);

    const response = await push(owner, [await invoiceOp(owner, 'op-offline-invoice')]);
    const [result] = response.body.results;
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(result.warnings[0].code, 'LIMIT_EXCEEDED_OFFLINE');

    // Counted and flagged, not refused.
    const usage = await documentUsage(owner.business);
    assert.equal(usage.count, 2);
    assert.equal(usage.overage, 1);
    assert.equal(await Invoice.countDocuments({ business: owner.business._id }), 2);
  });

  it('keeps one operation\'s warning out of the other operations in the batch', async () => {
    const owner = await businessOn('starter');
    await setLimit(owner.business, LIMITS.documentsPerMonth, 0);
    setMode('warn');

    const response = await push(owner, [await invoiceOp(owner, 'op-batch-invoice'), expenseOp('op-batch-expense')]);
    assert.equal(response.status, 200, response.text);
    const [invoiceResult, expenseResult] = response.body.results;

    assert.equal(invoiceResult.warnings.length, 1);
    assert.equal(invoiceResult.warnings[0].metric, LIMITS.documentsPerMonth);
    assert.equal(expenseResult.warnings.length, 1);
    assert.equal(expenseResult.warnings[0].feature, 'expenses');
  });
});

// --- plan lifecycle ---------------------------------------------------------

describe('plan lifecycle', () => {
  it('grants a grandfathered business its Pro-equivalent features in on mode', async () => {
    const owner = await businessOn(LEGACY_PLAN_KEY);
    setMode('on');

    assert.equal((await listExpenses(owner)).status, 200);
  });

  it('blocks a pre-billing business with no subscription — which is why the P7 backfill gates on mode', async () => {
    clearPlanCache();
    await bootstrapBilling();
    const owner = await createTestContext();
    assert.equal(await Subscription.countDocuments({ business: owner.business._id }), 0);
    setMode('on');

    // Fallback entitlements are the default plan's, and Starter has no expenses. The backfill onto
    // legacy_pro (Decision 2) must land before enforcement is switched on.
    assert.equal((await listExpenses(owner)).status, 402);
  });

  it('follows an upgrade and a downgrade through the snapshot', async () => {
    const owner = await businessOn('starter');
    setMode('on');
    assert.equal((await listExpenses(owner)).status, 402);

    await applyPlan({ business: owner.business._id, plan: await Plan.findOne({ key: 'pro' }), action: 'upgraded' });
    assert.equal((await listExpenses(owner)).status, 200);

    await applyPlan({ business: owner.business._id, plan: await Plan.findOne({ key: 'starter' }), action: 'downgraded' });
    assert.equal((await listExpenses(owner)).status, 402);
  });

  it('falls back to the default plan when the subscription has expired', async () => {
    const owner = await businessOn('pro');
    await Subscription.updateOne(
      { business: owner.business._id },
      { $set: { currentPeriodEnd: new Date(Date.now() - 60_000), graceEndsAt: new Date(Date.now() - 30_000) } }
    );
    setMode('on');

    // Expired, so Pro's expenses are gone...
    assert.equal((await listExpenses(owner)).status, 402);
    // ...but the business can still bill, on Starter's terms. A billing lapse is never a lockout.
    assert.equal((await createInvoice(owner)).status, 201);
  });

  it('provisions a subscription on signup, so a new business goes through the engine', async () => {
    clearPlanCache();
    await bootstrapBilling();
    const owner = await createTestContext();
    await ensureSubscription({ business: owner.business });

    const subscription = await Subscription.findOne({ business: owner.business._id });
    assert.equal(subscription.planKey, 'starter');
  });
});
