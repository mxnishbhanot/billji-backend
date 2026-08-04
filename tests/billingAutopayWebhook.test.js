import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Notification from '../src/models/Notification.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionHistory from '../src/models/SubscriptionHistory.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import { reportActivationFailures } from '../src/services/billingReconciliation.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { ensureSubscription, resolveStatus } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';
import { autopayEvent, configureRazorpay, stubRazorpay, unconfigureRazorpay, webhookSignature } from './helpers/razorpayStub.js';

// THE AUTOPAY CYCLE.
//
// Everything that turns a mandate into money and money into a period. The invariants, in order of how
// badly they would hurt:
//   - a mandate authentication grants NOTHING (otherwise plans are free)
//   - a charge amount is checked against what we wrote BEFORE the debit (otherwise the event sets the price)
//   - the second cycle EXTENDS the period (otherwise every renewal silently shortens it)
//   - a redelivery does nothing (otherwise the period doubles)
//   - many cycles share one mandate id (otherwise the second renewal cannot even insert)

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

/** A business with a pending mandate for Pro monthly, exactly as enrolment leaves it. */
const enrolled = async () => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });

  const started = await request(app)
    .post('/api/v1/billing/checkout')
    .set(authHeader(context.token))
    .send({ planKey: 'pro', interval: 'month', autopay: true });
  assert.equal(started.status, 201, started.text);

  return context;
};

const sendEvent = (body, { signature, eventId = `evt_${Math.random().toString(16).slice(2)}` } = {}) => {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/api/v1/billing/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', signature ?? webhookSignature(raw))
    .set('x-razorpay-event-id', eventId)
    .send(raw);
};

const charged = (overrides = {}) =>
  autopayEvent({ event: 'subscription.charged', amount: MONTH_PRICE, ...overrides });

const subscriptionFor = (business) => Subscription.findOne({ business: business._id });

describe('mandate authentication', () => {
  it('marks the mandate live and grants absolutely nothing', async () => {
    const { business } = await enrolled();
    const before = await subscriptionFor(business);

    const response = await sendEvent(autopayEvent({ event: 'subscription.authenticated', status: 'authenticated' }));

    assert.equal(response.status, 200);
    const after = await subscriptionFor(business);
    assert.equal(after.autopay.status, 'authenticated');
    assert.ok(after.autopay.authenticatedAt);
    // A bank agreeing to allow debits is not a payment.
    assert.equal(after.autopay.enabled, false);
    assert.equal(after.planKey, before.planKey);
    assert.deepEqual(after.currentPeriodEnd, before.currentPeriodEnd);
    assert.equal(await SubscriptionPayment.countDocuments({ business: business._id }), 0);
  });

  it('rejects an unsigned mandate event', async () => {
    const { business } = await enrolled();

    const response = await sendEvent(autopayEvent({ event: 'subscription.authenticated' }), { signature: 'deadbeef' });

    assert.equal(response.status, 400);
    assert.equal((await subscriptionFor(business)).autopay.status, 'pending');
  });
});

describe('recurring charges', () => {
  it('creates a captured cycle row with a receipt and activates the plan', async () => {
    const { business } = await enrolled();

    const response = await sendEvent(charged({ paymentId: 'pay_CYCLE1' }));

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);

    const rows = await SubscriptionPayment.find({ business: business._id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'captured');
    assert.equal(rows[0].kind, 'subscription');
    assert.equal(rows[0].netAmount, MONTH_PRICE);
    assert.equal(rows[0].providerRefs.paymentId, 'pay_CYCLE1');
    assert.equal(rows[0].providerRefs.subscriptionId, 'sub_TEST1');
    assert.ok(rows[0].receipt.number.startsWith('BILLJI/'));
    // The link that says the plan was applied — and the marker reconcileCapturedPayments scans for.
    assert.ok(rows[0].subscription);

    const subscription = await subscriptionFor(business);
    assert.equal(subscription.planKey, 'pro');
    assert.equal(subscription.autopay.enabled, true);
    assert.equal(subscription.autopay.status, 'active');
    assert.ok(subscription.autopay.lastChargedAt);
    assert.ok(subscription.currentPeriodEnd > new Date());
  });

  it('extends the period on the next cycle instead of restarting it', async () => {
    const { business } = await enrolled();
    await sendEvent(charged({ paymentId: 'pay_CYCLE1' }));

    const afterFirst = await subscriptionFor(business);
    const firstEnd = afterFirst.currentPeriodEnd;

    await sendEvent(charged({ paymentId: 'pay_CYCLE2' }));

    const afterSecond = await subscriptionFor(business);
    // A renewal must add a month to the end the customer already has, not restart from today —
    // restarting silently shortens every cycle by however long the debit took to arrive.
    assert.ok(afterSecond.currentPeriodEnd > firstEnd, `${afterSecond.currentPeriodEnd} should be after ${firstEnd}`);
    const expected = new Date(firstEnd);
    expected.setMonth(expected.getMonth() + 1);
    assert.equal(afterSecond.currentPeriodEnd.toISOString(), expected.toISOString());

    const history = await SubscriptionHistory.find({ business: business._id }).sort({ createdAt: 1 });
    assert.equal(history.at(-1).action, 'renewed');
    // Sorted explicitly: an unsorted find() has no defined order, so .at(-1) would be a coin toss.
    assert.equal((await SubscriptionPayment.findOne({ 'providerRefs.paymentId': 'pay_CYCLE2' })).kind, 'renewal');
    assert.equal((await SubscriptionPayment.findOne({ 'providerRefs.paymentId': 'pay_CYCLE1' })).kind, 'subscription');
  });

  it('lets many cycles share one mandate id', async () => {
    // Would fail outright if providerRefs.subscriptionId were uniquely indexed like orderId/paymentId:
    // the second renewal could not insert, so the customer would be charged and granted nothing.
    const { business } = await enrolled();
    await sendEvent(charged({ paymentId: 'pay_CYCLE1' }));
    await sendEvent(charged({ paymentId: 'pay_CYCLE2' }));
    await sendEvent(charged({ paymentId: 'pay_CYCLE3' }));

    const rows = await SubscriptionPayment.find({ business: business._id, 'providerRefs.subscriptionId': 'sub_TEST1' });
    assert.equal(rows.length, 3);
  });

  it('ignores a redelivered charge, however many times it arrives', async () => {
    const { business } = await enrolled();
    await sendEvent(charged({ paymentId: 'pay_CYCLE1' }), { eventId: 'evt_one' });
    const end = (await subscriptionFor(business)).currentPeriodEnd;

    // Same provider payment id, different delivery id — the shape a dashboard "resend" produces.
    const again = await sendEvent(charged({ paymentId: 'pay_CYCLE1' }), { eventId: 'evt_two' });
    const third = await sendEvent(charged({ paymentId: 'pay_CYCLE1' }), { eventId: 'evt_one' });

    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(third.body.duplicate, true);
    assert.equal(await SubscriptionPayment.countDocuments({ business: business._id }), 1);
    assert.deepEqual((await subscriptionFor(business)).currentPeriodEnd, end);
  });

  it('records an unexpected amount as money received, and grants no time for it', async () => {
    const { business } = await enrolled();

    const response = await sendEvent(charged({ paymentId: 'pay_WRONG', amount: MONTH_PRICE * 3 }));

    assert.equal(response.status, 200);
    assert.equal(response.body.amountUnexpected, true);

    const row = await SubscriptionPayment.findOne({ 'providerRefs.paymentId': 'pay_WRONG' });
    // The provider really debited the customer: never lose it. But never grant a period we did not agree.
    assert.equal(row.status, 'captured');
    assert.equal(row.netAmount, MONTH_PRICE * 3);
    assert.ok(row.failureReason.includes(String(MONTH_PRICE)));
    assert.equal(row.subscription, null);

    const subscription = await subscriptionFor(business);
    assert.notEqual(subscription.planKey, 'pro');

    // And it reaches a human through the job that already exists for exactly this shape of row.
    const flagged = await reportActivationFailures({ now: new Date(Date.now() + 2 * 60 * 60 * 1000) });
    assert.equal(flagged.flagged, 1);
  });

  it('mirrors the next debit date so the upcoming-charge notice has something to read', async () => {
    const { business } = await enrolled();
    const chargeAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await sendEvent(charged({ paymentId: 'pay_CYCLE1', chargeAt }));

    const subscription = await subscriptionFor(business);
    assert.equal(Math.floor(subscription.autopay.nextDebitAt.getTime() / 1000), Math.floor(chargeAt.getTime() / 1000));
  });
});

describe('mandate failure states', () => {
  const liveMandate = async () => {
    const context = await enrolled();
    await sendEvent(charged({ paymentId: 'pay_CYCLE1' }));
    return context;
  };

  it('keeps access when a mandate halts, and tells the customer', async () => {
    const { business } = await liveMandate();
    const before = await subscriptionFor(business);

    const response = await sendEvent(autopayEvent({ event: 'subscription.halted', status: 'halted' }));

    assert.equal(response.status, 200);
    const after = await subscriptionFor(business);
    assert.equal(after.autopay.status, 'halted');
    assert.equal(after.autopay.enabled, false);
    // The customer paid for this period. A dead mandate must not shorten it.
    assert.deepEqual(after.currentPeriodEnd, before.currentPeriodEnd);
    assert.equal(resolveStatus(after, new Date()), 'active');

    const notification = await Notification.findOne({ business: business._id, type: 'autopay-halted' });
    assert.ok(notification, 'a halted mandate must be surfaced — it is the one state needing action');
  });

  it('counts a failed attempt without touching entitlements', async () => {
    const { business } = await liveMandate();
    const before = await subscriptionFor(business);

    await sendEvent(autopayEvent({ event: 'subscription.pending', status: 'pending' }));

    const after = await subscriptionFor(business);
    assert.equal(after.autopay.status, 'pending');
    assert.equal(after.autopay.failureCount, 1);
    assert.deepEqual(after.currentPeriodEnd, before.currentPeriodEnd);
    assert.ok(await Notification.findOne({ business: business._id, type: 'autopay-failed' }));
  });

  it('mirrors a provider-side cancellation without ending the paid period', async () => {
    const { business } = await liveMandate();
    const before = await subscriptionFor(business);

    await sendEvent(autopayEvent({ event: 'subscription.cancelled', status: 'cancelled' }));

    const after = await subscriptionFor(business);
    assert.equal(after.autopay.status, 'cancelled');
    assert.equal(after.autopay.enabled, false);
    assert.ok(after.autopay.cancelledAt);
    assert.deepEqual(after.currentPeriodEnd, before.currentPeriodEnd);
    assert.equal(resolveStatus(after, new Date()), 'active');
  });

  it('mirrors an exhausted mandate and leaves the plan alone', async () => {
    const { business } = await liveMandate();

    await sendEvent(autopayEvent({ event: 'subscription.completed', status: 'completed' }));

    const after = await subscriptionFor(business);
    assert.equal(after.autopay.status, 'completed');
    assert.equal(after.autopay.enabled, false);
    assert.equal(after.planKey, 'pro');
  });

  it('never reports past_due, whatever the mandate is doing', async () => {
    // past_due is in the enum and isEntitled() treats it as entitled, so returning it would either grant
    // access past grace or duplicate in_grace. The dunning signal lives in autopay.status instead.
    const { business } = await liveMandate();

    for (const event of ['subscription.pending', 'subscription.halted']) {
      await sendEvent(autopayEvent({ event, status: event.split('.')[1] }));
      assert.notEqual(resolveStatus(await subscriptionFor(business), new Date()), 'past_due');
    }
  });
});

describe('events we cannot attribute', () => {
  it('acknowledges a charge for a mandate that is not ours', async () => {
    await enrolled();

    const response = await sendEvent(charged({ subscriptionId: 'sub_SOMEONE_ELSE', paymentId: 'pay_X' }));

    // 200, not 5xx: retrying will not make an unknown mandate known.
    assert.equal(response.status, 200);
    assert.equal(response.body.unmatched, true);
  });

  it('falls back to the notes when the mandate id does not match', async () => {
    const { business } = await enrolled();
    const subscription = await subscriptionFor(business);

    const response = await sendEvent(
      charged({ subscriptionId: 'sub_RENAMED', paymentId: 'pay_NOTED', notes: { billjiSubscriptionId: String(subscription._id) } })
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.unmatched, undefined);
    assert.equal((await subscriptionFor(business)).planKey, 'pro');
  });
});

describe('manual purchases still behave exactly as before', () => {
  it('activates a one-time order on a business that also holds a mandate', async () => {
    const { token, business } = await enrolled();
    await sendEvent(charged({ paymentId: 'pay_CYCLE1' }));

    // A separate, ordinary yearly purchase alongside the live monthly mandate.
    const started = await request(app)
      .post('/api/v1/billing/checkout')
      .set(authHeader(token))
      .send({ planKey: 'business', interval: 'year' });
    assert.equal(started.status, 201, started.text);

    const captured = await sendEvent({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_MANUAL', order_id: started.body.checkout.orderId, status: 'captured', amount: started.body.checkout.amount } } }
    });

    assert.equal(captured.status, 200);
    assert.equal(captured.body.success, true);
    const subscription = await subscriptionFor(business);
    assert.equal(subscription.planKey, 'business');
    const row = await SubscriptionPayment.findOne({ 'providerRefs.paymentId': 'pay_MANUAL' });
    assert.equal(row.status, 'captured');
    // A manual row carries no mandate id — that field is what marks a cycle as autopay.
    assert.equal(row.providerRefs.subscriptionId, '');
  });
});
