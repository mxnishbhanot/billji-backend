import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Coupon, { CouponRedemption } from '../src/models/Coupon.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionHistory from '../src/models/SubscriptionHistory.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import { nextReceiptNumber } from '../src/services/billingService.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { applyPlan, ensureSubscription, resolveStatus } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';
import { configureRazorpay, paymentSignature, stubRazorpay, unconfigureRazorpay } from './helpers/razorpayStub.js';

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

const seeded = async () => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });
  return context;
};

const checkout = (token, payload) => request(app).post('/api/v1/billing/checkout').set(authHeader(token)).send(payload);
const verify = (token, payload) => request(app).post('/api/v1/billing/checkout/verify').set(authHeader(token)).send(payload);

const buyPro = async (token, { interval = 'year', couponCode } = {}) => {
  const started = await checkout(token, { planKey: 'pro', interval, couponCode });
  assert.equal(started.status, 201, started.text);
  const { orderId } = started.body.checkout;
  const paymentId = razorpay.state.paymentId;

  const confirmed = await verify(token, { orderId, paymentId, signature: paymentSignature({ orderId, paymentId }) });
  return { started, confirmed };
};

describe('checkout order creation', () => {
  it('records our payment row before asking the provider for an order', async () => {
    const { token, business } = await seeded();
    const response = await checkout(token, { planKey: 'pro', interval: 'year' });

    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.checkout.amount, 199900);
    assert.equal(response.body.checkout.currency, 'INR');
    assert.equal(response.body.checkout.orderId, 'order_TEST1');
    // The publishable key is needed to open checkout; the secret must never appear.
    assert.equal(response.body.checkout.providerConfig.keyId, 'rzp_test_key');
    assert.ok(!JSON.stringify(response.body).includes('rzp_test_secret'));

    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.status, 'created');
    assert.equal(payment.netAmount, 199900);
    assert.equal(payment.planKey, 'pro');
    assert.equal(payment.providerRefs.orderId, 'order_TEST1');
    assert.ok(payment.receipt.number.startsWith('BILLJI/'));
  });

  it('sends the amount in paise and tags the order so a webhook can be matched', async () => {
    const { token, business } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'month' });

    const order = razorpay.calls.find((call) => call.path === '/orders');
    assert.equal(order.body.amount, 24900);
    assert.equal(order.body.payment_capture, 1);
    assert.equal(order.body.notes.businessId, String(business._id));
    assert.ok(order.body.notes.billjiPaymentId);
  });

  it('marks the payment failed when the provider rejects the order', async () => {
    const { token, business } = await seeded();
    razorpay.state.failCreateOrder = true;

    const response = await checkout(token, { planKey: 'pro', interval: 'year' });
    assert.equal(response.status, 400);

    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.status, 'failed', 'an abandoned intent must not sit in `created` forever');
    assert.equal(await Subscription.countDocuments({ business: business._id, planKey: 'pro' }), 0);
  });

  it('maps a provider outage to 502 rather than a 500', async () => {
    const { token } = await seeded();
    razorpay.state.networkDown = true;

    const response = await checkout(token, { planKey: 'pro', interval: 'year' });
    assert.equal(response.status, 502);
    assert.equal(response.body.details?.code || response.body.code, 'PROVIDER_UNREACHABLE');
  });

  it('refuses to open a checkout with no provider configured', async () => {
    const { token } = await seeded();
    unconfigureRazorpay();

    const response = await checkout(token, { planKey: 'pro', interval: 'year' });
    assert.equal(response.status, 503, 'a half-configured processor must never fall through to a free activation');
  });

  it('refuses a private plan for self-serve purchase', async () => {
    const { token } = await seeded();
    const response = await checkout(token, { planKey: 'enterprise', interval: 'year' });

    assert.equal(response.status, 403);
    assert.equal(response.body.details?.code, 'PLAN_REQUIRES_SALES_CONTACT');
  });

  it('refuses a body that names no plan', async () => {
    const { token } = await seeded();
    const response = await checkout(token, { interval: 'year' });
    assert.equal(response.status, 422, response.text);
  });

  it('refuses an interval the plan does not sell', async () => {
    const { token } = await seeded();
    const response = await checkout(token, { planKey: 'starter', interval: 'month' });
    assert.equal(response.status, 400);
  });

  it('refuses when there is nothing to charge', async () => {
    const { token } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    pro.prices.find((price) => price.interval === 'year').amount = 0;
    await pro.save();

    const response = await checkout(token, { planKey: 'pro', interval: 'year' });
    assert.equal(response.status, 422);
    assert.equal(response.body.details?.code, 'NOTHING_TO_CHARGE');
  });

  it('replays the first order for a repeated idempotency key', async () => {
    const { token, business } = await seeded();
    const send = () =>
      request(app)
        .post('/api/v1/billing/checkout')
        .set(authHeader(token))
        .set('Idempotency-Key', 'upgrade-tap-1')
        .send({ planKey: 'pro', interval: 'year' });

    const first = await send();
    const second = await send();

    assert.equal(first.status, 201, first.text);
    assert.equal(second.status, 201, second.text);
    assert.equal(second.headers['idempotency-replayed'], 'true');
    assert.equal(
      await SubscriptionPayment.countDocuments({ business: business._id }),
      1,
      'a double tap must not open two orders the customer could pay twice'
    );
  });
});

// REGRESSION (audit P1-1 / P1-5). The mobile client sent no Idempotency-Key, so the middleware
// short-circuited and a double tap minted two payable orders. The server now refuses to open a second
// order for the same terms on its own — the client header is defence in depth, not the only defence.
describe('duplicate checkout protection', () => {
  it('hands back the order already open for the same plan instead of minting a second one', async () => {
    const { token, business } = await seeded();

    const first = await checkout(token, { planKey: 'pro', interval: 'year' });
    const second = await checkout(token, { planKey: 'pro', interval: 'year' });

    assert.equal(second.status, 201, second.text);
    assert.equal(second.body.checkout.orderId, first.body.checkout.orderId);
    assert.equal(second.body.checkout.paymentId, first.body.checkout.paymentId);
    assert.equal(second.body.checkout.resumed, true);
    assert.equal(await SubscriptionPayment.countDocuments({ business: business._id }), 1, 'one order, not two');
  });

  it('still opens a fresh order once the open one has aged out', async () => {
    const { token, business } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'year' });

    // Through the driver: Mongoose marks `createdAt` immutable, so a model-level $set is dropped.
    await SubscriptionPayment.collection.updateOne(
      { business: business._id },
      { $set: { createdAt: new Date(Date.now() - 30 * 60 * 1000) } }
    );
    razorpay.state.orderId = 'order_LATER';

    const later = await checkout(token, { planKey: 'pro', interval: 'year' });
    assert.equal(later.status, 201, later.text);
    assert.equal(later.body.checkout.orderId, 'order_LATER');
    assert.equal(await SubscriptionPayment.countDocuments({ business: business._id }), 2);
  });

  it('refuses to price the same unused days into a second, different purchase', async () => {
    const { token, business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    // A running paid period is what makes a proration credit exist at all.
    await applyPlan({ business: business._id, plan: pro, interval: 'year', amount: 199900, action: 'activated' });

    const yearly = await checkout(token, { planKey: 'business', interval: 'year' });
    assert.equal(yearly.status, 201, yearly.text);
    assert.ok(yearly.body.checkout.breakdown.proratedCredit > 0, 'this checkout carries a credit');

    // Different terms, so not the resume path — but the same unused days would be credited again, and
    // paying both would buy one plan while spending the credit twice.
    razorpay.state.orderId = 'order_SECOND';
    const monthly = await checkout(token, { planKey: 'business', interval: 'month' });

    assert.equal(monthly.status, 409, monthly.text);
    assert.equal(monthly.body.details.code, 'CHECKOUT_ALREADY_OPEN');
  });

  it('records what the credit was priced against, so a stale one is detectable', async () => {
    const { token, business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    const subscription = await applyPlan({
      business: business._id,
      plan: pro,
      interval: 'year',
      amount: 199900,
      action: 'activated'
    });

    await checkout(token, { planKey: 'business', interval: 'year' });

    const payment = await SubscriptionPayment.findOne({ business: business._id, planKey: 'business' });
    assert.ok(payment.proratedCredit > 0);
    assert.equal(payment.creditBasisPeriodEnd.getTime(), subscription.currentPeriodEnd.getTime());
  });
});

describe('payment verification', () => {
  it('activates the plan on a valid signature and captured payment', async () => {
    const { token, business } = await seeded();
    const { confirmed } = await buyPro(token);

    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(confirmed.body.subscription.planKey, 'pro');
    assert.equal(confirmed.body.subscription.subscriptionStatus, 'active');
    assert.equal(confirmed.body.payment.status, 'captured');
    assert.equal(confirmed.body.payment.netAmount, 199900);

    const subscription = await Subscription.findOne({ business: business._id });
    // BillJi computed this, not Razorpay.
    assert.ok(subscription.currentPeriodEnd > new Date(Date.now() + 360 * DAY));
    assert.equal(subscription.entitlements.features.get('expenses'), true);
    assert.equal(subscription.pricing.amount, 199900);
  });

  it('rejects a forged signature and does not activate', async () => {
    const { token, business } = await seeded();
    const started = await checkout(token, { planKey: 'pro', interval: 'year' });
    const { orderId } = started.body.checkout;

    const response = await verify(token, { orderId, paymentId: 'pay_TEST1', signature: 'deadbeef' });

    assert.equal(response.status, 400);
    assert.equal(response.body.details?.code, 'PAYMENT_SIGNATURE_INVALID');
    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'starter');

    // Noted but NOT failed: a bad signature is a client problem and says nothing about whether
    // money moved. Failing the row would lock out a genuine payment.captured webhook, which only
    // activates from created/authorized — so a customer who really paid could never be activated.
    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.status, 'created');
    assert.match(payment.failureReason, /signature verification failed/);
  });

  it('still activates from the webhook after a bad client signature', async () => {
    const { token, business } = await seeded();
    const started = await checkout(token, { planKey: 'pro', interval: 'year' });
    const { orderId } = started.body.checkout;

    await verify(token, { orderId, paymentId: 'pay_TEST1', signature: 'deadbeef' });

    // The customer genuinely paid; the provider says so.
    const { activateFromPayment } = await import('../src/services/billingService.js');
    await activateFromPayment({
      payment: await SubscriptionPayment.findOne({ business: business._id }),
      providerPaymentId: 'pay_TEST1',
      eventId: 'evt_after_bad_signature'
    });

    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'pro');
  });

  it('will not let a client confirm a manual bank transfer', async () => {
    const { token, business } = await seeded();
    const started = await checkout(token, { planKey: 'pro', interval: 'year', provider: 'manual' });
    const { orderId } = started.body.checkout;

    const response = await verify(token, { orderId, paymentId: 'x', signature: 'x'.repeat(64) });
    assert.equal(response.status, 400);
    assert.equal(response.body.details?.code, 'PAYMENT_CONFIRMED_MANUALLY');
    // Still awaiting a human who has seen the money — not flipped to failed.
    assert.equal((await SubscriptionPayment.findOne({ business: business._id })).status, 'created');
  });

  it('rejects a signature made with the wrong secret', async () => {
    const { token } = await seeded();
    const started = await checkout(token, { planKey: 'pro', interval: 'year' });
    const { orderId } = started.body.checkout;

    const response = await verify(token, {
      orderId,
      paymentId: 'pay_TEST1',
      signature: paymentSignature({ orderId, paymentId: 'pay_TEST1', secret: 'attacker-secret' })
    });
    assert.equal(response.status, 400);
  });

  it('refuses a payment that is not captured yet', async () => {
    const { token, business } = await seeded();
    razorpay.state.paymentStatus = 'authorized';

    const started = await checkout(token, { planKey: 'pro', interval: 'year' });
    const { orderId } = started.body.checkout;
    const response = await verify(token, { orderId, paymentId: 'pay_TEST1', signature: paymentSignature({ orderId, paymentId: 'pay_TEST1' }) });

    assert.equal(response.status, 409);
    assert.equal(response.body.details?.code, 'PAYMENT_NOT_CAPTURED');
    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'starter');
  });

  it('refuses when the provider reports a different amount', async () => {
    const { token, business } = await seeded();
    const started = await checkout(token, { planKey: 'pro', interval: 'year' });
    const { orderId } = started.body.checkout;
    // A genuine signature over a payment worth ₹1 instead of ₹1,999.
    razorpay.state.paymentAmount = 100;

    const response = await verify(token, { orderId, paymentId: 'pay_TEST1', signature: paymentSignature({ orderId, paymentId: 'pay_TEST1' }) });

    assert.equal(response.status, 400);
    assert.equal(response.body.details?.code, 'PAYMENT_AMOUNT_MISMATCH');
    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'starter');
  });

  it('refuses a genuine payment belonging to another order', async () => {
    const { token } = await seeded();
    const started = await checkout(token, { planKey: 'pro', interval: 'year' });
    const { orderId } = started.body.checkout;
    // Signature is valid, but the payment Razorpay reports belongs elsewhere.
    razorpay.state.orderId = 'order_SOMEONE_ELSE';

    const response = await verify(token, { orderId, paymentId: 'pay_TEST1', signature: paymentSignature({ orderId, paymentId: 'pay_TEST1' }) });
    assert.equal(response.status, 400);
    assert.equal(response.body.details?.code, 'PAYMENT_ORDER_MISMATCH');
  });

  it('is idempotent — a repeated verify does not extend the period twice', async () => {
    const { token, business } = await seeded();
    const { started } = await buyPro(token);
    const { orderId } = started.body.checkout;

    const first = await Subscription.findOne({ business: business._id });
    const again = await verify(token, { orderId, paymentId: 'pay_TEST1', signature: paymentSignature({ orderId, paymentId: 'pay_TEST1' }) });
    const second = await Subscription.findOne({ business: business._id });

    assert.equal(again.status, 200, again.text);
    assert.equal(second.currentPeriodEnd.getTime(), first.currentPeriodEnd.getTime());
    assert.equal(await SubscriptionPayment.countDocuments({ business: business._id, status: 'captured' }), 1);
  });

  it('rejects an unknown order', async () => {
    const { token } = await seeded();
    const response = await verify(token, { orderId: 'order_NOPE', paymentId: 'pay_X', signature: 'x'.repeat(64) });
    assert.equal(response.status, 404);
  });

  it('cannot verify another business\'s order', async () => {
    const { token } = await seeded();
    const started = await checkout(token, { planKey: 'pro', interval: 'year' });
    const { orderId } = started.body.checkout;

    const outsider = await createTestContext();
    await ensureSubscription({ business: outsider.business });
    const response = await verify(outsider.token, { orderId, paymentId: 'pay_TEST1', signature: paymentSignature({ orderId, paymentId: 'pay_TEST1' }) });

    assert.equal(response.status, 404, 'a payment is scoped to the business that opened it');
  });
});

describe('renewal, upgrade and proration', () => {
  it('extends a renewal from the existing period end, not from today', async () => {
    const { token, business } = await seeded();
    await buyPro(token);
    const first = await Subscription.findOne({ business: business._id });

    razorpay.state.orderId = 'order_TEST2';
    razorpay.state.paymentId = 'pay_TEST2';
    await buyPro(token);
    const renewed = await Subscription.findOne({ business: business._id });

    const addedDays = Math.round((renewed.currentPeriodEnd - first.currentPeriodEnd) / DAY);
    assert.ok(addedDays >= 364 && addedDays <= 366, `renewal added ${addedDays} days`);
    const history = await SubscriptionHistory.findOne({ business: business._id, action: 'renewed' });
    assert.ok(history, 'a renewal is recorded as a renewal, not a fresh activation');
  });

  it('credits the unused part of the current plan against an upgrade', async () => {
    const { token, business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    // Half a month of a ₹249 plan already paid for.
    await applyPlan({
      business,
      plan: pro,
      interval: 'month',
      amount: 24900,
      now: new Date(Date.now() - 15 * DAY)
    });

    const response = await checkout(token, { planKey: 'business', interval: 'month' });
    const { breakdown } = response.body.checkout;

    assert.equal(breakdown.gross, 49900);
    assert.ok(breakdown.proratedCredit > 11000 && breakdown.proratedCredit < 13500, `credit was ${breakdown.proratedCredit}`);
    assert.equal(breakdown.netAmount, breakdown.gross - breakdown.proratedCredit);
  });

  it('does not credit a renewal of the same plan', async () => {
    const { token, business } = await seeded();
    const pro = await Plan.findOne({ key: 'pro' });
    await applyPlan({ business, plan: pro, interval: 'month', amount: 24900, now: new Date(Date.now() - 15 * DAY) });

    const response = await checkout(token, { planKey: 'pro', interval: 'month' });
    // Renewing already extends from the period end, so a credit would pay twice for the same days.
    assert.equal(response.body.checkout.breakdown.proratedCredit, 0);
    assert.equal(response.body.checkout.breakdown.netAmount, 24900);
  });

  it('gives an upgraded business the new entitlements immediately', async () => {
    const { token, business } = await seeded();
    await buyPro(token);

    razorpay.state.orderId = 'order_TEST3';
    razorpay.state.paymentId = 'pay_TEST3';
    const started = await checkout(token, { planKey: 'business', interval: 'year' });
    const { orderId } = started.body.checkout;
    const confirmed = await verify(token, { orderId, paymentId: 'pay_TEST3', signature: paymentSignature({ orderId, paymentId: 'pay_TEST3' }) });

    assert.equal(confirmed.body.subscription.planKey, 'business');
    assert.equal(confirmed.body.subscription.features.teams, true);
    assert.equal(confirmed.body.subscription.limits.team_members, 10);
    assert.ok(await SubscriptionHistory.findOne({ business: business._id, action: 'upgraded' }));
  });
});

describe('coupons', () => {
  const makeCoupon = (overrides = {}) =>
    Coupon.create({ code: 'SAVE20', type: 'percent', value: 20, ...overrides });

  it('previews a discount without writing anything', async () => {
    const { token } = await seeded();
    await makeCoupon();

    const response = await request(app)
      .post('/api/v1/billing/coupons/preview')
      .set(authHeader(token))
      .send({ code: 'save20', planKey: 'pro', interval: 'year' });

    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.coupon.valid, true);
    assert.equal(response.body.coupon.discount, 39980);
    assert.equal(response.body.coupon.netAmount, 159920);
    assert.equal(await CouponRedemption.countDocuments(), 0, 'a preview must not consume a redemption');
    assert.equal((await Coupon.findOne({ code: 'SAVE20' })).redemptionCount, 0);
  });

  it('explains why a coupon does not apply', async () => {
    const { token } = await seeded();
    await makeCoupon({ appliesTo: { planKeys: ['business'], intervals: [] } });

    const response = await request(app)
      .post('/api/v1/billing/coupons/preview')
      .set(authHeader(token))
      .send({ code: 'SAVE20', planKey: 'pro', interval: 'year' });

    assert.equal(response.body.coupon.valid, false);
    assert.match(response.body.coupon.reason, /does not apply to this plan/);
    // A bad code must never silently become a full-price charge.
    assert.equal(response.body.coupon.netAmount, 199900);
  });

  it('charges the discounted amount and records the redemption on capture', async () => {
    const { token, business } = await seeded();
    await makeCoupon({ type: 'fixed', value: 50000 });

    const { confirmed } = await buyPro(token, { couponCode: 'SAVE20' });
    assert.equal(confirmed.status, 200, confirmed.text);

    const order = razorpay.calls.find((call) => call.path === '/orders');
    assert.equal(order.body.amount, 149900);

    const redemption = await CouponRedemption.findOne({ business: business._id });
    assert.ok(redemption, 'a captured payment records the redemption');
    assert.equal(redemption.discountAmount, 50000);
    assert.equal((await Coupon.findOne({ code: 'SAVE20' })).redemptionCount, 1);
  });

  it('refuses an expired coupon at checkout', async () => {
    const { token } = await seeded();
    await makeCoupon({ validUntil: new Date(Date.now() - DAY) });

    const response = await checkout(token, { planKey: 'pro', interval: 'year', couponCode: 'SAVE20' });
    assert.equal(response.status, 422);
    assert.equal(response.body.details?.code, 'COUPON_NOT_APPLICABLE');
  });

  it('never discounts below zero', async () => {
    const { token } = await seeded();
    await makeCoupon({ type: 'fixed', value: 9999900 });

    const response = await request(app)
      .post('/api/v1/billing/coupons/preview')
      .set(authHeader(token))
      .send({ code: 'SAVE20', planKey: 'pro', interval: 'year' });

    assert.equal(response.body.coupon.discount, 199900);
    assert.equal(response.body.coupon.netAmount, 0);
  });

  it('cannot be redeemed past its cap under concurrency', async () => {
    clearPlanCache();
    await bootstrapBilling();
    const coupon = await Coupon.create({ code: 'LIMITED', type: 'percent', value: 10, maxRedemptions: 3 });
    const { redeemCoupon } = await import('../src/services/couponService.js');

    const businesses = await Promise.all(Array.from({ length: 10 }, () => createTestContext()));
    const attempts = await Promise.allSettled(
      businesses.map((context) => redeemCoupon({ coupon, business: context.business._id, discountAmount: 100 }))
    );

    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 3);
    assert.equal((await Coupon.findOne({ code: 'LIMITED' })).redemptionCount, 3);
    assert.equal(await CouponRedemption.countDocuments({ coupon: coupon._id }), 3);
  });

  it('refuses a second use by the same business', async () => {
    const { token, business } = await seeded();
    await makeCoupon();
    await buyPro(token, { couponCode: 'SAVE20' });

    const response = await request(app)
      .post('/api/v1/billing/coupons/preview')
      .set(authHeader(token))
      .send({ code: 'SAVE20', planKey: 'pro', interval: 'year' });

    assert.equal(response.body.coupon.valid, false);
    assert.match(response.body.coupon.reason, /already used/);
    assert.equal(await CouponRedemption.countDocuments({ business: business._id }), 1);
  });
});

describe('trial', () => {
  it('grants the paid plan entitlements without a payment', async () => {
    const { token, business } = await seeded();
    const response = await request(app).post('/api/v1/billing/trial').set(authHeader(token)).send({ planKey: 'pro' });

    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.subscription.subscriptionStatus, 'trialing');
    assert.equal(response.body.subscription.isTrial, true);
    assert.equal(response.body.subscription.features.expenses, true);
    // A trial is not a paid period.
    assert.equal(response.body.subscription.renewalDate, null);
    assert.ok(response.body.subscription.trialEndsAt);
    assert.equal(await SubscriptionPayment.countDocuments({ business: business._id }), 0);
  });

  it('is once per business, ever', async () => {
    const { token } = await seeded();
    await request(app).post('/api/v1/billing/trial').set(authHeader(token)).send({ planKey: 'pro' });
    const second = await request(app).post('/api/v1/billing/trial').set(authHeader(token)).send({ planKey: 'business' });

    assert.equal(second.status, 409);
    assert.equal(second.body.details?.code, 'TRIAL_ALREADY_USED');
  });

  it('refuses a plan with no trial', async () => {
    const { token } = await seeded();
    const response = await request(app).post('/api/v1/billing/trial').set(authHeader(token)).send({ planKey: 'starter' });

    assert.equal(response.status, 400);
    assert.equal(response.body.details?.code, 'TRIAL_NOT_AVAILABLE');
  });

  it('expires back to the default plan without locking anyone out', async () => {
    const { token, business } = await seeded();
    await request(app).post('/api/v1/billing/trial').set(authHeader(token)).send({ planKey: 'pro' });

    await Subscription.updateOne({ business: business._id }, { $set: { 'trial.endsAt': new Date(Date.now() - DAY) } });

    const response = await request(app).get('/api/v1/billing/subscription').set(authHeader(token));
    assert.equal(response.body.subscription.subscriptionStatus, 'expired');
    assert.equal(response.body.subscription.planKey, 'starter');
    assert.equal(response.body.subscription.features.gst_billing, true);
    assert.equal(response.body.subscription.features.expenses, undefined);
  });

  it('converts to paid, and the trial latch survives', async () => {
    const { token, business } = await seeded();
    await request(app).post('/api/v1/billing/trial').set(authHeader(token)).send({ planKey: 'pro' });
    const { confirmed } = await buyPro(token);

    assert.equal(confirmed.body.subscription.subscriptionStatus, 'active');
    assert.equal(confirmed.body.subscription.isTrial, false);
    assert.equal((await Subscription.findOne({ business: business._id })).trial.used, true);
  });
});

describe('cancel and reactivate', () => {
  it('keeps access to the end of the period already paid for', async () => {
    const { token, business } = await seeded();
    await buyPro(token);

    const response = await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({ reason: 'too expensive' });
    assert.equal(response.status, 200, response.text);

    // Paid for a year; cancelling must not take it away today.
    assert.equal(response.body.subscription.subscriptionStatus, 'active');
    assert.equal(response.body.subscription.cancelAtPeriodEnd, true);
    assert.equal(response.body.subscription.renewalDate, null);
    assert.ok(response.body.subscription.expiryDate);
    assert.equal(response.body.subscription.features.expenses, true);

    const subscription = await Subscription.findOne({ business: business._id });
    assert.equal(resolveStatus(subscription, new Date(subscription.cancel.effectiveAt.getTime() + 1)), 'cancelled');
  });

  it('records the reason in history', async () => {
    const { token, business } = await seeded();
    await buyPro(token);
    await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({ reason: 'switching tools' });

    const history = await SubscriptionHistory.findOne({ business: business._id, action: 'cancelled' });
    assert.equal(history.metadata.reason, 'switching tools');
  });

  it('refuses an immediate cancellation from a customer', async () => {
    const { token } = await seeded();
    await buyPro(token);

    const response = await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({ immediate: true });
    assert.equal(response.status, 422, 'ending access early is a support action, not self-serve');
  });

  it('reactivates a pending cancellation', async () => {
    const { token } = await seeded();
    await buyPro(token);
    await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({});

    const response = await request(app).post('/api/v1/billing/reactivate').set(authHeader(token)).send({});
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.subscription.cancelAtPeriodEnd, false);
    assert.ok(response.body.subscription.renewalDate);
  });

  it('refuses to reactivate what was never cancelled', async () => {
    const { token } = await seeded();
    await buyPro(token);

    const response = await request(app).post('/api/v1/billing/reactivate').set(authHeader(token)).send({});
    assert.equal(response.status, 409);
  });
});

describe('payment history', () => {
  it('lists captured payments and hides abandoned checkouts', async () => {
    const { token } = await seeded();
    await buyPro(token);
    // An abandoned attempt.
    razorpay.state.orderId = 'order_ABANDONED';
    await checkout(token, { planKey: 'business', interval: 'year' });

    const response = await request(app).get('/api/v1/billing/payments').set(authHeader(token));
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.payments.length, 1);

    const [payment] = response.body.payments;
    assert.equal(payment.status, 'captured');
    assert.equal(payment.netAmount, 199900);
    assert.equal(payment.planKey, 'pro');
    assert.ok(payment.receiptNumber.startsWith('BILLJI/'));
    assert.ok(payment.paidAt);
  });

  it('exposes no provider identifiers or raw payloads', async () => {
    const { token } = await seeded();
    await buyPro(token);

    const { body } = await request(app).get('/api/v1/billing/payments').set(authHeader(token));
    for (const leaked of ['providerRefs', 'raw', 'webhookEventIds', 'failureReason', '_id', 'business']) {
      assert.ok(!(leaked in body.payments[0]), `payment DTO leaks ${leaked}`);
    }
  });

  // REGRESSION (audit P1-2). Receipt numbers were allocated by reading the current maximum and adding
  // one, so two concurrent checkouts both read the same maximum and both received
  // BILLJI/2026-27/000001. They come from NumberSequence now — the same guarded $inc every other
  // series uses.
  it('never issues the same receipt number twice under concurrency', async () => {
    await seeded();

    // Straight at the allocator: 20 simultaneous claims. Read-max-then-add-1 handed several of these
    // the identical number; a guarded $inc cannot.
    const numbers = await Promise.all(Array.from({ length: 20 }, () => nextReceiptNumber()));

    assert.equal(new Set(numbers).size, 20, `duplicate receipt numbers issued: ${numbers.join(', ')}`);
    assert.ok(numbers.every((number) => /^BILLJI\/\d{4}-\d{2}\/\d{6}$/.test(number)), 'format unchanged');
  });

  it('rejects a second payment row carrying an already-issued receipt number', async () => {
    const { token, business } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'year' });
    const existing = await SubscriptionPayment.findOne({ business: business._id });

    // Belt to the allocator's braces: even a future code path that bypassed NumberSequence cannot
    // persist a duplicate.
    await assert.rejects(
      () =>
        SubscriptionPayment.create({
          business: business._id,
          provider: 'manual',
          amount: 100,
          netAmount: 100,
          receipt: { number: existing.receipt.number }
        }),
      (error) => error.code === 11000
    );
  });

  it('numbers receipts sequentially within the financial year', async () => {
    const { token } = await seeded();
    await checkout(token, { planKey: 'pro', interval: 'year' });
    razorpay.state.orderId = 'order_TEST2';
    await checkout(token, { planKey: 'business', interval: 'year' });

    const numbers = (await SubscriptionPayment.find().sort({ createdAt: 1 })).map((payment) => payment.receipt.number);
    assert.equal(numbers.length, 2);
    assert.equal(Number(numbers[1].split('/').pop()), Number(numbers[0].split('/').pop()) + 1);
  });
});

describe('authorization', () => {
  it('lets a viewer read the plan but not the invoices, and not spend money', async () => {
    clearPlanCache();
    await bootstrapBilling();
    const viewer = await createTestContext({ roleKey: 'viewer' });
    await ensureSubscription({ business: viewer.business });

    const read = await request(app).get('/api/v1/billing/subscription').set(authHeader(viewer.token));
    assert.equal(read.status, 200, read.text);

    // Invoices are financial records, one notch narrower than plan status: billing.invoices, which
    // an accountant holds and a viewer does not.
    const invoices = await request(app).get('/api/v1/billing/payments').set(authHeader(viewer.token));
    assert.equal(invoices.status, 403);

    const spend = await checkout(viewer.token, { planKey: 'pro', interval: 'year' });
    assert.equal(spend.status, 403);
    assert.equal(spend.body.details?.code || spend.body.code, 'FORBIDDEN_PERMISSION');
  });

  it('lets an accountant see invoices but not change the plan', async () => {
    clearPlanCache();
    await bootstrapBilling();
    const accountant = await createTestContext({ roleKey: 'accountant' });
    await ensureSubscription({ business: accountant.business });

    assert.equal((await request(app).get('/api/v1/billing/payments').set(authHeader(accountant.token))).status, 200);
    assert.equal((await request(app).post('/api/v1/billing/cancel').set(authHeader(accountant.token)).send({})).status, 403);
  });
});
