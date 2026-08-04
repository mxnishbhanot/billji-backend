import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from './auditService.js';
import { applyCapturedPayment, nextReceiptNumber } from './billingService.js';
import { upsertNotification } from './notificationService.js';
import { getProvider } from './payments/index.js';

// AUTOPAY LIFECYCLE — the mandate half of billing.
//
// billingService owns "what does this cost and what does it buy". This file owns "the provider says a
// mandate changed state", and translates exactly one of those states into money: a successful debit.
// Everything else is a mirror write and a notification.
//
// Three invariants hold this together. Break any of them and the feature becomes a way to give away
// plans or to cut off paying customers:
//
//   1. A MANDATE IS NOT MONEY. `subscription.authenticated` means a bank agreed to allow debits. It
//      grants no access, extends no period, writes no payment row. Only a charge does that.
//   2. A PERIOD COMES ONLY FROM A CHARGE WITH A PAYMENT ID. Never from a status read, never from a
//      date the provider reports. The audit chain from money to entitlement must stay unbroken.
//   3. THE AMOUNT IS CHECKED AGAINST WHAT WE WROTE BEFORE THE DEBIT
//      (`Subscription.autopay.chargeAmount`), never against the event. For a one-time payment the
//      order fixes the amount; for a recurring one, this field is the only equivalent.
//
// Cycle rows are created here rather than at enrolment, which is what makes the first debit and the
// sixtieth one code path. Dedup is the unique partial index on `providerRefs.paymentId`: one provider
// payment per debit, so a redelivered event cannot insert twice.

/** Provider status -> BillJi's own vocabulary. The only place the two meet. */
const STATUS_FROM_EVENT = {
  'subscription.authenticated': 'authenticated',
  'subscription.charged': 'active',
  'subscription.pending': 'pending',
  'subscription.halted': 'halted',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'completed'
};

export const AUTOPAY_EVENTS = Object.keys(STATUS_FROM_EVENT);

/** Alert of last resort, same shape as billingReconciliation's: stderr plus the audit trail. */
const alert = (business, action, metadata) => {
  console.error(`[billing] ${action}`, JSON.stringify(metadata));
  return logAudit(null, { business, action, resourceType: 'subscription', metadata });
};

/**
 * The mandate a signed event belongs to.
 *
 * Provider subscription id first — it is the id we wrote at enrolment. `notes` is the fallback, for
 * the same reason the one-time path falls back to `notes.billjiPaymentId`: an event we can attribute
 * is worth more than a tidy lookup.
 */
const findMandate = async (event) => {
  if (event.subscriptionId) {
    const byId = await Subscription.findOne({ 'provider.subscriptionId': event.subscriptionId });
    if (byId) return byId;
  }

  const notes = event.raw?.payload?.subscription?.entity?.notes || event.raw?.payload?.payment?.entity?.notes || {};
  if (notes.billjiSubscriptionId) {
    const byNote = await Subscription.findById(notes.billjiSubscriptionId).catch(() => null);
    if (byNote) return byNote;
  }
  if (notes.businessId) {
    return Subscription.findOne({ business: notes.businessId }).catch(() => null);
  }
  return null;
};

/**
 * Records a successful recurring debit and turns it into a period.
 *
 * Returns `{ payment, alreadyApplied, amountUnexpected }`. Called by BOTH the webhook and the
 * client's mandate confirmation, whichever lands first — the unique payment-id index makes the loser
 * a no-op, exactly as the atomic status claim does on the one-time path.
 */
export const recordAutopayCharge = async ({
  subscription,
  paymentId,
  amount,
  eventId = '',
  method = '',
  raw = {},
  actor = { type: 'system' },
  now = new Date()
}) => {
  if (!paymentId) {
    // A charge with no provider payment id cannot be deduped and cannot be audited back to money.
    throw new ApiError(400, 'A recurring charge must carry a provider payment id', { code: 'AUTOPAY_CHARGE_NO_PAYMENT_ID' });
  }

  const existing = await SubscriptionPayment.findOne({ 'providerRefs.paymentId': paymentId });
  if (existing) {
    return { payment: existing, alreadyApplied: true, amountUnexpected: false };
  }

  const autopay = subscription.autopay || {};
  // THE guard. Deliberately NOT amountMatchesPayment: that compares against the row's own
  // netAmount, and this row is built FROM the event — it would pass tautologically.
  const amountUnexpected = Number(amount) !== Number(autopay.chargeAmount);

  let payment;
  try {
    payment = await SubscriptionPayment.create({
      business: subscription.business,
      // Left null on purpose: it is the "activated" marker, so a crash between this insert and
      // applyCapturedPayment below heals through the existing reconcileCapturedPayments sweep.
      subscription: null,
      kind: autopay.lastChargedAt ? 'renewal' : 'subscription',
      provider: subscription.provider?.name || 'razorpay',
      // The money already moved — the provider debited before telling us. Recording it as anything
      // other than captured would understate what the customer paid.
      status: 'captured',
      amount,
      netAmount: amount,
      discount: 0,
      currency: autopay.currency || 'INR',
      // Plan and interval come from the mandate we set up, NEVER from the event.
      planKey: autopay.planKey,
      billingInterval: autopay.interval,
      providerRefs: { subscriptionId: subscription.provider?.subscriptionId || '', paymentId },
      ...(eventId ? { webhookEventIds: [eventId] } : {}),
      ...(amountUnexpected
        ? {
            failureReason:
              `Recurring charge ${amount} does not match the authorised amount ${autopay.chargeAmount}; ` +
              'the money is recorded but no period was granted. Needs manual review.'
          }
        : {}),
      receipt: { number: await nextReceiptNumber(now) },
      raw
    });
  } catch (error) {
    if (error?.code === 11000) {
      // Lost the race against the other confirmation path. Report its row, not a failure.
      const winner = await SubscriptionPayment.findOne({ 'providerRefs.paymentId': paymentId });
      if (winner) return { payment: winner, alreadyApplied: true, amountUnexpected: false };
    }
    throw error;
  }

  if (amountUnexpected) {
    // Never lose money; never grant time nobody authorised. The row stays `captured` with a reason,
    // which the existing reportActivationFailures job already surfaces hourly.
    await alert(subscription.business, 'billing.autopay.amount_unexpected', {
      subscriptionId: String(subscription._id),
      paymentId: String(payment._id),
      expected: autopay.chargeAmount,
      received: amount
    });
    return { payment, alreadyApplied: false, amountUnexpected: true };
  }

  // The unchanged funnel. applyCapturedPayment derives `renewed` vs `upgraded` vs `activated` from
  // the subscription's current plan, and applyPlan extends from currentPeriodEnd for `renewed` — so
  // a renewal keeps the days the customer already had, with no autopay-specific date arithmetic.
  const applied = await applyCapturedPayment({ claimed: payment, actor, now });

  await Subscription.updateOne(
    { _id: subscription._id },
    {
      $set: {
        'autopay.enabled': true,
        'autopay.status': 'active',
        'autopay.lastChargedAt': now,
        'autopay.failureCount': 0,
        ...(method ? { 'provider.mandateId': method } : {})
      }
    }
  );

  return { payment: applied.payment || payment, alreadyApplied: false, amountUnexpected: false };
};

/** Mirrors a non-charge mandate state and tells the customer when they need to act. */
const applyMandateState = async ({ subscription, event, now }) => {
  const status = STATUS_FROM_EVENT[event.event];
  const isTerminal = ['halted', 'cancelled', 'completed'].includes(status);

  const update = {
    'autopay.status': status,
    // `enabled` means "a mandate is live and charging", and ONLY a successful charge may turn it on
    // (see recordAutopayCharge). A terminal state turns it off; `authenticated` and `pending` leave it
    // exactly as it was — a bank agreeing to allow debits, or retrying one, is not autopay working.
    ...(isTerminal ? { 'autopay.enabled': false } : {}),
    ...(event.subscriptionChargeAt ? { 'autopay.nextDebitAt': event.subscriptionChargeAt } : {}),
    ...(status === 'authenticated' ? { 'autopay.authenticatedAt': now } : {}),
    ...(status === 'cancelled' || status === 'completed' ? { 'autopay.cancelledAt': now } : {}),
    ...(event.subscriptionEntity?.customer_id ? { 'provider.customerId': event.subscriptionEntity.customer_id } : {})
  };

  await Subscription.updateOne(
    { _id: subscription._id },
    { $set: update, ...(status === 'pending' ? { $inc: { 'autopay.failureCount': 1 } } : {}) }
  );

  // Entitlements are untouched by every branch here: access still runs on currentPeriodEnd and
  // graceEndsAt, exactly as it does for a manual subscriber. A failed debit must not cut off a
  // customer who has already paid for this period.
  if (status === 'halted') {
    await upsertNotification({
      business: subscription.business,
      notificationId: `autopay-halted:${subscription._id}:${event.eventId || event.subscriptionId}`,
      type: 'autopay-halted',
      resourceType: 'subscription',
      resourceId: String(subscription._id),
      tone: 'danger',
      title: 'Automatic payment stopped',
      description: 'Your bank stopped the automatic payment. Renew manually to keep your plan, then turn autopay back on.',
      to: '/subscription',
      sortDate: now
    });
  }

  if (status === 'pending') {
    await upsertNotification({
      business: subscription.business,
      notificationId: `autopay-failed:${subscription._id}:${event.eventId || String(now.getTime())}`,
      type: 'autopay-failed',
      resourceType: 'subscription',
      resourceId: String(subscription._id),
      tone: 'warning',
      title: 'Automatic payment could not be taken',
      description: 'Your bank declined the renewal. We will try again — or you can renew manually now.',
      to: '/subscription',
      sortDate: now
    });
  }

  if (status === 'completed') {
    // The authorised cycle count ran out. Nothing is lost (manual renewal reminders resume by
    // themselves), but it also fires when total_count was set too low, which ops should see.
    await alert(subscription.business, 'billing.autopay.completed', {
      subscriptionId: String(subscription._id),
      providerSubscriptionId: subscription.provider?.subscriptionId || ''
    });
  }
};

/**
 * The webhook entry point for every `subscription.*` event.
 *
 * Response policy is the existing one, unchanged: 200 for anything signed that we cannot act on
 * (retrying will not make an unknown mandate known), 5xx only for our own failures.
 */
export const handleAutopayEvent = async ({ event, res, now = new Date() }) => {
  if (!STATUS_FROM_EVENT[event.event]) {
    return res.json({ success: true, ignored: event.event });
  }

  const subscription = await findMandate(event);
  if (!subscription) {
    console.error(`[billing] ${event.event} has no matching mandate (subscription=${event.subscriptionId})`);
    return res.json({ success: true, unmatched: true });
  }

  if (event.event === 'subscription.charged') {
    const { alreadyApplied, amountUnexpected } = await recordAutopayCharge({
      subscription,
      paymentId: event.paymentId,
      amount: event.amount,
      eventId: event.eventId,
      method: event.raw?.payload?.payment?.entity?.method || '',
      raw: event.raw,
      actor: { type: 'webhook', note: event.event },
      now
    });

    // nextDebitAt is mirrored even on a duplicate: the provider may have moved the clock forward
    // without us seeing the event that did it.
    if (event.subscriptionChargeAt) {
      await Subscription.updateOne({ _id: subscription._id }, { $set: { 'autopay.nextDebitAt': event.subscriptionChargeAt } });
    }

    if (alreadyApplied) return res.json({ success: true, duplicate: true });
    if (amountUnexpected) return res.json({ success: true, amountUnexpected: true });
    return res.json({ success: true });
  }

  await applyMandateState({ subscription, event, now });
  return res.json({ success: true });
};

/**
 * The client's half of mandate confirmation — the mirror of verifyCheckout.
 *
 * Exists so the UI can unlock immediately instead of waiting for a webhook. The provider is still
 * the authority: the signature proves the pair is genuine, and the payment is re-fetched before
 * anything is granted.
 *
 * `payment` comes back null when the mandate is approved but no debit has landed yet. That is a
 * success, not an error — the plan activates on `subscription.charged`.
 */
export const confirmAutopayMandate = async ({ business, subscriptionId, paymentId, signature, now = new Date() }) => {
  const subscription = await Subscription.findOne({
    business: business._id || business,
    'provider.subscriptionId': subscriptionId
  });

  if (!subscription) {
    // Also what blocks confirming another business's mandate, same as the order path's scoping.
    throw new ApiError(404, 'That autopay setup does not belong to this business', { code: 'AUTOPAY_NOT_FOUND' });
  }

  const provider = getProvider(subscription.provider?.name || undefined);
  if (!provider.verifyMandateSignature({ subscriptionId, paymentId, signature })) {
    // Recorded, but the mandate is NOT failed: the webhook may still confirm it legitimately, and a
    // bad client signature must not be a way to break someone's autopay.
    await alert(subscription.business, 'billing.autopay.signature_invalid', {
      subscriptionId: String(subscription._id),
      providerSubscriptionId: subscriptionId
    });
    throw new ApiError(400, 'We could not verify that payment. Nothing has been charged twice.', {
      code: 'MANDATE_SIGNATURE_INVALID'
    });
  }

  const remote = await provider.fetchPayment(paymentId);
  if (remote.subscriptionId && remote.subscriptionId !== subscriptionId) {
    throw new ApiError(400, 'That payment belongs to a different autopay setup', { code: 'PAYMENT_SUBSCRIPTION_MISMATCH' });
  }

  // The mandate is real from here on, whatever the payment says.
  subscription.autopay.status = subscription.autopay.status === 'active' ? 'active' : 'authenticated';
  subscription.autopay.authenticatedAt = subscription.autopay.authenticatedAt || now;
  await subscription.save();

  if (!remote.captured) {
    // Approved, nothing debited yet. The webhook finishes the job.
    return { payment: null, alreadyApplied: false, mandateOnly: true };
  }

  const { payment, alreadyApplied } = await recordAutopayCharge({
    subscription,
    paymentId: remote.paymentId,
    amount: remote.amount,
    method: remote.method || '',
    raw: remote.raw,
    actor: { type: 'user' },
    now
  });

  return { payment, alreadyApplied };
};
