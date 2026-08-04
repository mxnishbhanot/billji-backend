import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { ensureSubscription, resolveStatus } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';
import { autopayEvent, configureRazorpay, stubRazorpay, unconfigureRazorpay, webhookSignature } from './helpers/razorpayStub.js';

// STOPPING A MANDATE.
//
// The worst outcome this whole feature can produce is a subscription BillJi thinks is cancelled while
// the mandate keeps debiting. So: the mandate is stopped first, and if the provider will not confirm
// that, nothing is cancelled locally.
//
// Also locked here: "turn autopay off" and "cancel my subscription" stay different actions.

useMongoTestDb();

const MONTH_PRICE = 24900;
let razorpay;

beforeEach(() => {
  configureRazorpay();
  razorpay = stubRazorpay();
});

afterEach(() => {
  razorpay.restore();
  unconfigureRazorpay();
});

const sendEvent = (body) => {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/api/v1/billing/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', webhookSignature(raw))
    .set('x-razorpay-event-id', `evt_${Math.random().toString(16).slice(2)}`)
    .send(raw);
};

/** A business on Pro monthly with a live, charged mandate. */
const withLiveMandate = async () => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });

  await request(app)
    .post('/api/v1/billing/checkout')
    .set(authHeader(context.token))
    .send({ planKey: 'pro', interval: 'month', autopay: true });
  await sendEvent(autopayEvent({ event: 'subscription.charged', amount: MONTH_PRICE, paymentId: 'pay_CYCLE1' }));

  return context;
};

const manualSubscriber = async () => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });

  const started = await request(app)
    .post('/api/v1/billing/checkout')
    .set(authHeader(context.token))
    .send({ planKey: 'pro', interval: 'month' });
  await sendEvent({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_MANUAL', order_id: started.body.checkout.orderId, status: 'captured', amount: started.body.checkout.amount } } }
  });

  return context;
};

const subscriptionFor = (business) => Subscription.findOne({ business: business._id });
const cancelPaths = () => razorpay.calls.filter((call) => call.path.endsWith('/cancel')).map((call) => call.body);

describe('cancelling a subscription with a live mandate', () => {
  it('stops the mandate at the provider, at cycle end, and cancels locally', async () => {
    const { token, business } = await withLiveMandate();

    const response = await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({ reason: 'too expensive' });

    assert.equal(response.status, 200, response.text);
    assert.deepEqual(cancelPaths(), [{ cancel_at_cycle_end: 1 }]);

    const subscription = await subscriptionFor(business);
    assert.ok(subscription.cancel.effectiveAt, 'the local cancellation must be recorded too');
    assert.equal(subscription.autopay.enabled, false);
    assert.equal(subscription.autopay.status, 'cancelled');
    assert.equal(subscription.autopay.nextDebitAt, null);
    // Access runs to the end of the period already paid for.
    assert.equal(resolveStatus(subscription, new Date()), 'active');
  });

  it('cancels NOTHING locally when the provider will not stop the mandate', async () => {
    const { token, business } = await withLiveMandate();
    razorpay.state.failCancelSubscription = true;
    // ...and the read-back still says live, so this is a genuine failure rather than an already-settled one.
    razorpay.state.remoteSubscription.status = 'active';

    const response = await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({});

    assert.ok(response.status >= 400, `expected a failure, got ${response.status}`);
    const subscription = await subscriptionFor(business);
    // A "cancelled" subscription whose mandate is still debiting is the outcome this guard exists for.
    assert.equal(subscription.cancel.effectiveAt, null);
    assert.equal(subscription.autopay.enabled, true);
  });

  it('treats an already-cancelled mandate as success', async () => {
    const { token, business } = await withLiveMandate();
    razorpay.state.failCancelSubscription = true;
    // The provider refuses because it is already cancelled — the outcome we wanted holds, so read it
    // back rather than pattern-matching an error message that is not a contract.
    razorpay.state.remoteSubscription.status = 'cancelled';

    const response = await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({});

    assert.equal(response.status, 200, response.text);
    const subscription = await subscriptionFor(business);
    assert.ok(subscription.cancel.effectiveAt);
    assert.equal(subscription.autopay.enabled, false);
  });

  it('makes no provider call at all for a manual subscriber', async () => {
    const { token } = await manualSubscriber();

    const response = await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({});

    assert.equal(response.status, 200, response.text);
    assert.deepEqual(cancelPaths(), []);
  });
});

describe('turning autopay off', () => {
  it('keeps the plan and the paid period, and only stops the mandate', async () => {
    const { token, business } = await withLiveMandate();
    const before = await subscriptionFor(business);

    const response = await request(app).post('/api/v1/billing/autopay/off').set(authHeader(token)).send({});

    assert.equal(response.status, 200, response.text);
    assert.deepEqual(cancelPaths(), [{ cancel_at_cycle_end: 1 }]);

    const after = await subscriptionFor(business);
    assert.equal(after.autopay.enabled, false);
    assert.equal(after.autopay.status, 'cancelled');
    // NOT a cancellation: this is the difference customers must be able to rely on.
    assert.equal(after.cancel.effectiveAt, null);
    assert.deepEqual(after.currentPeriodEnd, before.currentPeriodEnd);
    assert.equal(after.planKey, 'pro');
    assert.equal(response.body.subscription.autopay.enabled, false);
    assert.equal(response.body.subscription.subscriptionStatus, 'active');
  });

  it('is a no-op the second time, not an error', async () => {
    const { token } = await withLiveMandate();
    await request(app).post('/api/v1/billing/autopay/off').set(authHeader(token)).send({});

    const again = await request(app).post('/api/v1/billing/autopay/off').set(authHeader(token)).send({});

    assert.equal(again.status, 200, again.text);
    assert.equal(cancelPaths().length, 1);
  });

  it('is a no-op for a manual subscriber, with no provider call', async () => {
    const { token } = await manualSubscriber();

    const response = await request(app).post('/api/v1/billing/autopay/off').set(authHeader(token)).send({});

    assert.equal(response.status, 200, response.text);
    assert.deepEqual(cancelPaths(), []);
  });
});

describe('reactivate', () => {
  it('clears the pending cancellation but does NOT resurrect the mandate', async () => {
    const { token, business } = await withLiveMandate();
    await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({});

    const response = await request(app).post('/api/v1/billing/reactivate').set(authHeader(token)).send({});

    assert.equal(response.status, 200, response.text);
    const subscription = await subscriptionFor(business);
    assert.equal(subscription.cancel.effectiveAt, null);
    // A cancelled mandate cannot be revived — re-enrolling needs fresh bank authentication. The client
    // offers "turn autopay back on", which is a new enrolment.
    assert.equal(subscription.autopay.enabled, false);
    assert.equal(subscription.autopay.status, 'cancelled');
  });
});

describe('a charge that races a cancellation', () => {
  it('honours the money: the period extends and the pending cancellation clears', async () => {
    const { token, business } = await withLiveMandate();
    await request(app).post('/api/v1/billing/cancel').set(authHeader(token)).send({});
    const cancelled = await subscriptionFor(business);
    assert.ok(cancelled.cancel.effectiveAt);

    // cancel_at_cycle_end means the provider may still fire ONE charge if the request landed inside the
    // pre-debit window. The customer was charged, so they get the period — and applyPlan clears the
    // pending cancellation, which is the honest outcome rather than a bug to guard.
    await sendEvent(autopayEvent({ event: 'subscription.charged', amount: MONTH_PRICE, paymentId: 'pay_RACE' }));

    const after = await subscriptionFor(business);
    assert.equal(after.cancel.effectiveAt, null);
    assert.ok(after.currentPeriodEnd > cancelled.currentPeriodEnd);
  });
});

describe('refunds and the mandate', () => {
  it('stops the mandate when the current cycle is fully refunded', async () => {
    const { business } = await withLiveMandate();

    await sendEvent({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_FULL', payment_id: 'pay_CYCLE1', amount: MONTH_PRICE, status: 'processed' } } }
    });

    // Without this, we refund the customer and debit them again next month.
    assert.deepEqual(cancelPaths(), [{ cancel_at_cycle_end: 1 }]);
    const subscription = await subscriptionFor(business);
    assert.equal(subscription.autopay.enabled, false);
    assert.ok(subscription.cancel.effectiveAt);
    assert.equal((await SubscriptionPayment.findOne({ 'providerRefs.paymentId': 'pay_CYCLE1' })).status, 'refunded');
  });

  it('leaves the mandate alone on a partial refund', async () => {
    const { business } = await withLiveMandate();

    await sendEvent({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_HALF', payment_id: 'pay_CYCLE1', amount: MONTH_PRICE / 2, status: 'processed' } } }
    });

    assert.deepEqual(cancelPaths(), []);
    const subscription = await subscriptionFor(business);
    assert.equal(subscription.autopay.enabled, true);
    assert.equal((await SubscriptionPayment.findOne({ 'providerRefs.paymentId': 'pay_CYCLE1' })).status, 'partially_refunded');
  });

  it('leaves the mandate alone when an older cycle is refunded', async () => {
    const { business } = await withLiveMandate();
    await sendEvent(autopayEvent({ event: 'subscription.charged', amount: MONTH_PRICE, paymentId: 'pay_CYCLE2' }));

    // Refunding cycle 1 must not revoke the period cycle 2 has already paid for.
    await sendEvent({
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_OLD', payment_id: 'pay_CYCLE1', amount: MONTH_PRICE, status: 'processed' } } }
    });

    assert.deepEqual(cancelPaths(), []);
    const subscription = await subscriptionFor(business);
    assert.equal(subscription.autopay.enabled, true);
    assert.equal(subscription.cancel.effectiveAt, null);
  });
});
