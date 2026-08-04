import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { getAutopayProvider } from '../src/services/payments/index.js';
import manualProvider from '../src/services/payments/manualProvider.js';
import { applyPlan, ensureSubscription } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';
import { configureRazorpay, stubRazorpay, unconfigureRazorpay } from './helpers/razorpayStub.js';

// AUTOPAY ENROLMENT.
//
// The invariants here are about what enrolment must NOT do: not take money, not create a payment row,
// not accept a coupon or a proration credit into a recurring charge, and not mint a second mandate for
// a customer who already has one waiting.

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

const seeded = async () => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });
  return context;
};

const checkout = (token, payload, key) => {
  const req = request(app).post('/api/v1/billing/checkout').set(authHeader(token));
  if (key) req.set('Idempotency-Key', key);
  return req.send(payload);
};

const pathsCalled = (method) => razorpay.calls.filter((call) => call.method === method).map((call) => call.path);

describe('autopay enrolment', () => {
  it('returns a mandate instead of an order, and creates no payment row', async () => {
    const { token, business } = await seeded();

    const response = await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.checkout.autopay, true);
    assert.equal(response.body.checkout.subscriptionId, 'sub_TEST1');
    assert.equal(response.body.checkout.orderId, '');
    // The whole point of the design: a mandate that is never approved must leave nothing behind — no
    // abandoned row, and no receipt number burned on it.
    assert.equal(await SubscriptionPayment.countDocuments({ business: business._id }), 0);
  });

  it('records what the customer authorised, but does not switch autopay on', async () => {
    const { token, business } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    const subscription = await Subscription.findOne({ business: business._id });
    assert.equal(subscription.provider.subscriptionId, 'sub_TEST1');
    assert.equal(subscription.provider.customerId, 'cust_TEST1');
    assert.equal(subscription.autopay.status, 'pending');
    assert.equal(subscription.autopay.planKey, 'pro');
    assert.equal(subscription.autopay.interval, 'month');
    assert.equal(subscription.autopay.chargeAmount, 24900);
    // A mandate REQUEST is not a mandate. Only the first successful debit may flip this.
    assert.equal(subscription.autopay.enabled, false);
  });

  it('asks the provider for a plan and a subscription, and never for a customer', async () => {
    const { token } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    // /customers is deliberately unstubbed (it would 404): the subscription mints the customer, so
    // there is no customer management to own.
    assert.deepEqual(pathsCalled('POST'), ['/plans', '/subscriptions']);
  });

  it('reuses the cached provider plan for a second enrolment at the same price', async () => {
    const { token } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    const second = await createTestContext();
    await ensureSubscription({ business: second.business });
    await checkout(second.token, { planKey: 'pro', interval: 'month', autopay: true });

    assert.deepEqual(pathsCalled('POST'), ['/plans', '/subscriptions', '/subscriptions']);
    assert.equal(razorpay.state.planIds.length, 1);
  });

  it('mints a new provider plan when the price changes, and keeps the old cache entry', async () => {
    const { token } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    // A provider plan is immutable, so a repriced plan MUST NOT reuse the old id — the mandate would
    // charge the old amount forever.
    await Plan.updateOne({ key: 'pro', 'prices.interval': 'month' }, { $set: { 'prices.$.amount': 29900 } });
    clearPlanCache();

    const second = await createTestContext();
    await ensureSubscription({ business: second.business });
    await checkout(second.token, { planKey: 'pro', interval: 'month', autopay: true });

    assert.equal(razorpay.state.planIds.length, 2);
    assert.deepEqual(razorpay.state.planIds, ['plan_monthly_24900', 'plan_monthly_29900']);

    const plan = await Plan.findOne({ key: 'pro' });
    const refs = plan.prices.find((price) => price.interval === 'month').providerRefs;
    // Both keys survive: mandates already running still point at the old provider plan.
    assert.equal(refs.get('razorpay:month:1:INR:24900'), 'plan_monthly_24900');
    assert.equal(refs.get('razorpay:month:1:INR:29900'), 'plan_monthly_29900');
  });

  it('keeps cached plan ids across a normal reseed, and re-mints after a forced one', async () => {
    const { token } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    // The seeder refreshes presentation only, so it cannot stomp a cached id.
    await bootstrapBilling();
    let plan = await Plan.findOne({ key: 'pro' });
    assert.equal(plan.prices.find((price) => price.interval === 'month').providerRefs.get('razorpay:month:1:INR:24900'), 'plan_monthly_24900');

    // A deliberate reset replaces prices wholesale. Losing the cache is harmless — it is only ever read
    // to mint a NEW mandate — but it must not throw.
    await bootstrapBilling({ force: true });
    clearPlanCache();
    plan = await Plan.findOne({ key: 'pro' });
    assert.equal(plan.prices.find((price) => price.interval === 'month').providerRefs?.size || 0, 0);

    const second = await createTestContext();
    await ensureSubscription({ business: second.business });
    const again = await checkout(second.token, { planKey: 'pro', interval: 'month', autopay: true });
    assert.equal(again.status, 201, again.text);
  });
});

describe('autopay refusals', () => {
  it('refuses a coupon on a mandate and names the manual path', async () => {
    const { token } = await seeded();
    // Discounting one cycle of a recurring charge is a different promise; the manual path owns coupons.
    const response = await checkout(token, { planKey: 'pro', interval: 'month', autopay: true, couponCode: 'LAUNCH50' });

    assert.equal(response.status, 422);
    assert.equal(response.body.details?.code || response.body.code, 'AUTOPAY_NO_COUPON');
    assert.equal(pathsCalled('POST').length, 0);
  });

  it('refuses a mandate that would carry a proration credit', async () => {
    const { token, business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    // Mid-period on Pro: switching to Business would credit the unused days, and a credit priced into a
    // recurring charge would repeat every cycle.
    await applyPlan({ business: business._id, plan: pro, interval: 'month', action: 'activated', amount: 24900 });

    const response = await checkout(token, { planKey: 'business', interval: 'month', autopay: true });

    assert.equal(response.status, 422);
    assert.equal(response.body.details?.code || response.body.code, 'AUTOPAY_NO_PRORATION');
    assert.equal(pathsCalled('POST').length, 0);
  });

  it('refuses a provider that cannot hold a mandate', async () => {
    const { token } = await seeded();
    const response = await checkout(token, { planKey: 'pro', interval: 'month', autopay: true, provider: 'manual' });

    assert.equal(response.status, 400);
    assert.equal(response.body.details?.code || response.body.code, 'PROVIDER_NO_AUTOPAY');
  });

  it('leaves the autopay methods undefined on the manual provider rather than stubbing them', () => {
    // Absence, not a throwing stub: a caller that skipped the capability gate should die loudly at the
    // exact wrong line instead of surfacing a 400 that reads like the customer's fault.
    assert.equal(manualProvider.supportsAutopay, false);
    assert.equal(manualProvider.createSubscription, undefined);
    assert.equal(manualProvider.ensureProviderPlan, undefined);
    assert.equal(manualProvider.cancelProviderSubscription, undefined);
    assert.throws(() => getAutopayProvider('manual'), (error) => error.details?.code === 'PROVIDER_NO_AUTOPAY');
  });

  it('says WHY when the provider refuses the credentials', async () => {
    const { token } = await seeded();
    // The real shape of "this account does not have Subscriptions enabled": a 401 carrying a bare
    // string instead of Razorpay's usual { error: { description } }. Without its own branch it became a
    // reasonless 502 that reads like a customer problem.
    razorpay.state.unauthorized = true;

    const response = await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    assert.equal(response.status, 502);
    assert.equal(response.body.details?.code, 'PROVIDER_UNAUTHORIZED');
    assert.match(response.body.details.providerReason, /POST \/plans \(401\)/);
  });

  it('refuses an interval the provider cannot charge recurrently', async () => {
    const { token } = await seeded();
    const response = await checkout(token, { planKey: 'pro', interval: 'lifetime', autopay: true });

    // Caught by the route validator (422) before any autopay code runs — 'lifetime' is not purchasable
    // on either path. The AUTOPAY_INTERVAL_UNSUPPORTED guard behind it is the belt for a caller that
    // reaches createCheckout directly.
    assert.equal(response.status, 422, response.text);
    assert.equal(pathsCalled('POST').length, 0);
  });
});

describe('autopay double-tap protection', () => {
  it('creates one mandate for a replayed Idempotency-Key', async () => {
    const { token } = await seeded();
    const key = 'autopay-double-tap';

    const first = await checkout(token, { planKey: 'pro', interval: 'month', autopay: true }, key);
    const second = await checkout(token, { planKey: 'pro', interval: 'month', autopay: true }, key);

    assert.equal(first.body.checkout.subscriptionId, second.body.checkout.subscriptionId);
    assert.equal(pathsCalled('POST').filter((path) => path === '/subscriptions').length, 1);
  });

  it('hands back the pending mandate when the same terms are requested again without a key', async () => {
    const { token } = await seeded();

    await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });
    const again = await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    assert.equal(again.status, 201, again.text);
    assert.equal(again.body.checkout.resumed, true);
    assert.equal(again.body.checkout.subscriptionId, 'sub_TEST1');
    assert.equal(pathsCalled('POST').filter((path) => path === '/subscriptions').length, 1);
  });

  it('refuses different terms while a mandate is still waiting to be approved', async () => {
    const { token } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    const other = await checkout(token, { planKey: 'business', interval: 'month', autopay: true });

    assert.equal(other.status, 409);
    assert.equal(other.body.details?.code || other.body.code, 'AUTOPAY_ALREADY_PENDING');
  });

  it('refuses a second enrolment once the mandate is live', async () => {
    const { token, business } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });
    await Subscription.updateOne({ business: business._id }, { $set: { 'autopay.status': 'active', 'autopay.enabled': true } });

    const again = await checkout(token, { planKey: 'pro', interval: 'month', autopay: true });

    assert.equal(again.status, 409);
    assert.equal(again.body.details?.code || again.body.code, 'AUTOPAY_ALREADY_ACTIVE');
  });
});

describe('manual checkout is unaffected', () => {
  it('still mints an order and a created payment row when autopay is not asked for', async () => {
    const { token, business } = await seeded();

    const response = await checkout(token, { planKey: 'pro', interval: 'year' });

    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.checkout.autopay, false);
    assert.equal(response.body.checkout.orderId, 'order_TEST1');
    assert.equal(response.body.checkout.subscriptionId, undefined);
    const rows = await SubscriptionPayment.find({ business: business._id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'created');
    assert.ok(rows[0].receipt.number.startsWith('BILLJI/'));
    assert.deepEqual(pathsCalled('POST'), ['/orders']);
  });
});
