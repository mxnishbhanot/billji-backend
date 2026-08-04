import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Plan from '../src/models/Plan.js';
import AuditLog from '../src/models/AuditLog.js';
import Notification from '../src/models/Notification.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionHistory from '../src/models/SubscriptionHistory.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import { nextReceiptNumber } from '../src/services/billingService.js';
import {
  reconcileCapturedPayments,
  reportActivationFailures,
  sendGraceReminders,
  sendRenewalReminders
} from '../src/services/billingReconciliation.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { applyPlan, ensureSubscription } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { createTestContext } from './helpers/fixtures.js';

/**
 * The billing safety net (audit P0-3 / P1-4).
 *
 * Every case here is a sequence that was interrupted halfway. The engine's atomic claims make each
 * step safe; only these jobs make the *sequence* safe.
 */

useMongoTestDb();

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

let context;

beforeEach(async () => {
  clearPlanCache();
  await bootstrapBilling();
  context = await createTestContext();
  await ensureSubscription({ business: context.business });
});

/**
 * A payment in exactly the state a crash between the capture claim and the activation leaves behind:
 * money taken, status `captured`, and no subscription link — because that field is only written after
 * the plan is applied.
 */
const strandedPayment = async ({ planKey = 'pro', ageMs = 30 * MINUTE, netAmount = 199900 } = {}) => {
  const payment = await SubscriptionPayment.create({
    business: context.business._id,
    provider: 'razorpay',
    status: 'captured',
    kind: 'subscription',
    amount: netAmount,
    netAmount,
    planKey,
    billingInterval: 'year',
    providerRefs: { orderId: `order_${planKey}_${ageMs}`, paymentId: `pay_${planKey}_${ageMs}` },
    receipt: { number: await nextReceiptNumber() }
  });

  // Backdate through the driver: Mongoose refuses to let a model write move a timestamp.
  const past = new Date(Date.now() - ageMs);
  await SubscriptionPayment.collection.updateOne({ _id: payment._id }, { $set: { createdAt: past, updatedAt: past } });

  return SubscriptionPayment.findById(payment._id);
};

describe('captured-but-not-activated recovery', () => {
  it('activates the plan the customer paid for', async () => {
    const payment = await strandedPayment();

    const result = await reconcileCapturedPayments();
    assert.deepEqual({ recovered: result.recovered, failed: result.failed }, { recovered: 1, failed: 0 });

    const subscription = await Subscription.findOne({ business: context.business._id });
    assert.equal(subscription.planKey, 'pro');
    assert.equal(subscription.pricing.amount, 199900);
    assert.ok(subscription.currentPeriodEnd, 'a paid period was opened');

    const healed = await SubscriptionPayment.findById(payment._id);
    assert.equal(String(healed.subscription), String(subscription._id));
    assert.ok(healed.periodEnd, 'the period this payment bought is recorded on it');

    const audited = await AuditLog.findOne({ business: context.business._id, action: 'billing.activation.recovered' });
    assert.ok(audited, 'a recovery is auditable');
  });

  it('leaves a payment alone until the activation window has passed', async () => {
    await strandedPayment({ ageMs: 2 * MINUTE });

    const result = await reconcileCapturedPayments();
    assert.equal(result.scanned, 0, 'a payment captured seconds ago is in flight, not stuck');
    assert.equal((await Subscription.findOne({ business: context.business._id })).planKey, 'starter');
  });

  it('is idempotent — a second pass changes nothing', async () => {
    await strandedPayment();
    await reconcileCapturedPayments();

    const first = await Subscription.findOne({ business: context.business._id });
    const second = await reconcileCapturedPayments();

    assert.equal(second.recovered, 0);
    const after = await Subscription.findOne({ business: context.business._id });
    assert.equal(after.currentPeriodEnd.getTime(), first.currentPeriodEnd.getTime(), 'the period was not extended twice');
  });

  // The dangerous half of recovery: if the plan WAS applied and only the payment's own links were
  // lost, re-applying a renewal would extend the period a second time — a free year.
  it('backfills the links instead of re-applying a plan that already went through', async () => {
    const pro = await Plan.findOne({ key: 'pro' });
    const payment = await strandedPayment();
    const subscription = await applyPlan({
      business: context.business._id,
      plan: pro,
      interval: 'year',
      action: 'activated',
      amount: 199900,
      metadata: { paymentId: String(payment._id) }
    });
    const periodEnd = subscription.currentPeriodEnd.getTime();

    const result = await reconcileCapturedPayments();
    assert.deepEqual({ recovered: result.recovered, backfilled: result.backfilled }, { recovered: 0, backfilled: 1 });

    const after = await Subscription.findOne({ business: context.business._id });
    assert.equal(after.currentPeriodEnd.getTime(), periodEnd, 'the period was not extended a second time');
    const healed = await SubscriptionPayment.findById(payment._id);
    assert.equal(String(healed.subscription), String(after._id));
  });

  it('treats a matching subscription as applied even when the history write was lost', async () => {
    const pro = await Plan.findOne({ key: 'pro' });
    await strandedPayment();
    const subscription = await applyPlan({ business: context.business._id, plan: pro, interval: 'year', amount: 199900 });
    // History is fire-and-forget in production, so recovery must not depend on it.
    await SubscriptionHistory.deleteMany({ business: context.business._id });
    const periodEnd = subscription.currentPeriodEnd.getTime();

    const result = await reconcileCapturedPayments();

    assert.equal(result.recovered, 0);
    assert.equal((await Subscription.findOne({ business: context.business._id })).currentPeriodEnd.getTime(), periodEnd);
  });

  it('alerts, and does not swallow, a payment whose plan no longer exists', async () => {
    const payment = await strandedPayment({ planKey: 'ghost_plan' });

    const result = await reconcileCapturedPayments();
    assert.deepEqual({ recovered: result.recovered, failed: result.failed }, { recovered: 0, failed: 1 });

    const alert = await AuditLog.findOne({ business: context.business._id, action: 'billing.activation.recovery_failed' });
    assert.ok(alert, 'a customer who paid and has nothing always reaches a human');
    assert.equal(alert.metadata.paymentId, String(payment._id));
    // Money is never rolled back to make our bookkeeping tidy.
    assert.equal((await SubscriptionPayment.findById(payment._id)).status, 'captured');
  });

  it('keeps reporting captured payments that need manual review', async () => {
    const payment = await strandedPayment();
    payment.failureReason = 'Webhook amount 1 does not match the order amount 199900; needs manual review';
    await payment.save();
    await SubscriptionPayment.collection.updateOne(
      { _id: payment._id },
      { $set: { updatedAt: new Date(Date.now() - 30 * MINUTE) } }
    );

    const result = await reportActivationFailures();

    assert.equal(result.flagged, 1);
    const alert = await AuditLog.findOne({ business: context.business._id, action: 'billing.activation.needs_review' });
    assert.ok(alert);
    assert.match(alert.metadata.failureReason, /does not match/);
  });
});

describe('renewal reminders', () => {
  const periodEndingIn = async (ms, { planKey = 'pro' } = {}) => {
    const plan = await Plan.findOne({ key: planKey });
    const subscription = await applyPlan({ business: context.business._id, plan, interval: 'year', amount: 199900 });
    subscription.currentPeriodEnd = new Date(Date.now() + ms);
    subscription.graceEndsAt = new Date(subscription.currentPeriodEnd.getTime() + 7 * DAY);
    await subscription.save();
    return subscription;
  };

  it('warns a business before its plan lapses', async () => {
    await periodEndingIn(2 * DAY);

    const result = await sendRenewalReminders();
    assert.equal(result.sent, 1);

    const notification = await Notification.findOne({ business: context.business._id, type: 'subscription-renewal' });
    assert.ok(notification);
    assert.equal(notification.metadata.stage, 3, 'the tightest stage whose window has opened');
    assert.equal(notification.to, '/subscription');
  });

  it('says it once per stage, however often the sweep runs', async () => {
    await periodEndingIn(2 * DAY);

    await sendRenewalReminders();
    await sendRenewalReminders();
    await sendRenewalReminders();

    assert.equal(await Notification.countDocuments({ business: context.business._id, type: 'subscription-renewal' }), 1);
  });

  it('escalates as the date approaches instead of repeating one warning', async () => {
    const subscription = await periodEndingIn(2 * DAY);
    await sendRenewalReminders();

    subscription.currentPeriodEnd = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await subscription.save();
    await sendRenewalReminders();

    const stages = (await Notification.find({ business: context.business._id, type: 'subscription-renewal' })).map(
      (row) => row.metadata.stage
    );
    assert.deepEqual(stages.sort(), [1, 3]);
  });

  it('says nothing about a period that is not close, or one already cancelled', async () => {
    const subscription = await periodEndingIn(60 * DAY);
    assert.equal((await sendRenewalReminders()).sent, 0);

    subscription.currentPeriodEnd = new Date(Date.now() + 2 * DAY);
    subscription.cancel = { requestedAt: new Date(), effectiveAt: subscription.currentPeriodEnd, atPeriodEnd: true, reason: '' };
    await subscription.save();

    assert.equal((await sendRenewalReminders()).sent, 0, 'a customer who already cancelled is not chased to renew');
  });

  it('tells a lapsed business it is inside the grace window', async () => {
    const plan = await Plan.findOne({ key: 'pro' });
    const subscription = await applyPlan({ business: context.business._id, plan, interval: 'year', amount: 199900 });
    subscription.currentPeriodEnd = new Date(Date.now() - DAY);
    subscription.graceEndsAt = new Date(Date.now() + 5 * DAY);
    await subscription.save();

    assert.equal((await sendGraceReminders()).sent, 1);
    // Twice through the sweep, still one notification.
    await sendGraceReminders();

    const rows = await Notification.find({ business: context.business._id, type: 'subscription-grace' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tone, 'danger');
  });
});
