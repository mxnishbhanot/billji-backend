import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import { bootstrapRbac } from '../src/bootstrap/rbac.js';
import { BILLING_OWNER_ROLES } from '../src/constants/permissions.js';
import Permission from '../src/models/Permission.js';
import Role from '../src/models/Role.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { ensureSubscription } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';
import { configureRazorpay, stubRazorpay, unconfigureRazorpay } from './helpers/razorpayStub.js';

// Billing authorization is two independent layers and this file exists to prove they are
// independent: a permission decides what you SEE, ownership decides whether you may SPEND. The
// headline case is `admin` — every billing permission there is, and still not one rupee.

useMongoTestDb();

let razorpay;

beforeEach(() => {
  configureRazorpay();
  razorpay = stubRazorpay();
});

afterEach(() => {
  razorpay.restore();
  unconfigureRazorpay();
});

const contextFor = async (roleKey) => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext({ roleKey });
  await ensureSubscription({ business: context.business });
  return context;
};

const get = (path, token) => request(app).get(`/api/v1/billing${path}`).set(authHeader(token));
const post = (path, token, body = {}) => request(app).post(`/api/v1/billing${path}`).set(authHeader(token)).send(body);

/** Every money-changing route in the classification, exercised the cheapest way each allows. */
const moneyRoutes = (token) => [
  ['checkout', () => post('/checkout', token, { planKey: 'pro', interval: 'year' })],
  ['checkout/verify', () => post('/checkout/verify', token, { orderId: 'order_x', paymentId: 'pay_x', signature: 'sig' })],
  ['trial', () => post('/trial', token, { planKey: 'pro' })],
  ['cancel', () => post('/cancel', token, {})],
  ['reactivate', () => post('/reactivate', token)],
  ['autopay/off', () => post('/autopay/off', token)]
];

describe('billing: ownership is the final authority on money', () => {
  it('gives an admin every billing read and no way to spend', async () => {
    const admin = await contextFor('admin');

    // The permission layer is fully open to them.
    assert.equal((await get('/subscription', admin.token)).status, 200);
    assert.equal((await get('/usage', admin.token)).status, 200);
    assert.equal((await get('/plans', admin.token)).status, 200);
    assert.equal((await get('/payments', admin.token)).status, 200);
    // A quote is not a purchase — an admin may price the upgrade to put to the owner.
    assert.notEqual((await post('/coupons/preview', admin.token, { code: 'NOPE', planKey: 'pro', interval: 'year' })).status, 403);

    // The ownership layer is closed.
    for (const [name, call] of moneyRoutes(admin.token)) {
      const response = await call();
      assert.equal(response.status, 403, `${name} should be owner-only, got ${response.status}`);
      assert.equal(response.body.details?.code, 'FORBIDDEN_OWNER_ONLY', `${name} should fail on ownership, not permission`);
    }
  });

  it('lets an accountant read invoices and refuses the spend', async () => {
    const accountant = await contextFor('accountant');

    assert.equal((await get('/payments', accountant.token)).status, 200);
    for (const [name, call] of moneyRoutes(accountant.token)) {
      assert.equal((await call()).status, 403, `${name} should be refused for an accountant`);
    }
  });

  it('lets a viewer see the plan but not the invoices', async () => {
    const viewer = await contextFor('viewer');

    assert.equal((await get('/subscription', viewer.token)).status, 200);
    assert.equal((await get('/payments', viewer.token)).status, 403);
    assert.equal((await post('/trial', viewer.token, { planKey: 'pro' })).status, 403);
  });

  it('shows staff no billing at all', async () => {
    const staff = await contextFor('staff');

    assert.equal((await get('/subscription', staff.token)).status, 403);
    assert.equal((await get('/payments', staff.token)).status, 403);
  });

  it('lets the owner through to the real handler', async () => {
    const owner = await contextFor('owner');

    assert.equal((await get('/subscription', owner.token)).status, 200);
    assert.equal((await get('/payments', owner.token)).status, 200);
    // Reaches the checkout handler and opens a real order — not stopped by either guard.
    assert.equal((await post('/checkout', owner.token, { planKey: 'pro', interval: 'year' })).status, 201);
  });

  it('distinguishes a permission refusal from an ownership refusal', async () => {
    // The client renders different UI for these: "you can't see this" vs "ask the owner".
    const staff = await contextFor('staff');
    const admin = await contextFor('admin');

    assert.equal((await post('/cancel', staff.token, {})).body.details?.code, 'FORBIDDEN_PERMISSION');
    assert.equal((await post('/cancel', admin.token, {})).body.details?.code, 'FORBIDDEN_OWNER_ONLY');
  });

  it('refuses a custom role that was handed billing.manage', async () => {
    // The escalation the ownership layer exists to defeat: an admin with roles.manage mints a role
    // holding every billing permission and assigns it. Reads open up; spending does not.
    const context = await contextFor('staff');
    await bootstrapRbac(); // Permission documents come from the RBAC seed, not the billing one.
    const permissions = await Permission.find({ key: { $in: ['billing.view', 'billing.invoices', 'billing.manage'] } });
    assert.ok(permissions.length >= 3, 'billing permissions should be seeded');

    const role = await Role.create({
      business: context.business._id,
      name: 'Rogue Billing',
      key: 'rogue-billing',
      permissions: permissions.map((permission) => permission._id),
      isSystem: false
    });
    context.membership.role = role._id;
    await context.membership.save();

    assert.equal((await get('/payments', context.token)).status, 200, 'the permission layer should honour the custom role');
    const spend = await post('/checkout', context.token, { planKey: 'pro', interval: 'year' });
    assert.equal(spend.status, 403);
    assert.equal(spend.body.details?.code, 'FORBIDDEN_OWNER_ONLY');
  });

  it('reports canManageBilling from the server, per role', async () => {
    const owner = await contextFor('owner');
    const admin = await contextFor('admin');

    assert.equal((await get('/subscription', owner.token)).body.subscription.canManageBilling, true);
    assert.equal((await get('/subscription', admin.token)).body.subscription.canManageBilling, false);
    // One line of copy, and nothing more about the owner than that.
    const dto = (await get('/subscription', admin.token)).body.subscription;
    assert.equal(typeof dto.billingOwnerName, 'string');
    assert.equal(dto.owner, undefined);
  });

  it('widens to a new billing role by adding one entry to BILLING_OWNER_ROLES', async () => {
    // Forward compatibility for Billing Admin: no route, guard or DTO change should be needed.
    const admin = await contextFor('admin');
    assert.equal((await post('/checkout', admin.token, { planKey: 'pro', interval: 'year' })).status, 403);

    BILLING_OWNER_ROLES.push('admin');
    try {
      assert.equal((await post('/checkout', admin.token, { planKey: 'pro', interval: 'year' })).status, 201);
      assert.equal((await get('/subscription', admin.token)).body.subscription.canManageBilling, true);
    } finally {
      BILLING_OWNER_ROLES.pop();
    }
  });
});
