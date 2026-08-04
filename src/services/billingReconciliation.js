import Subscription from '../models/Subscription.js';
import SubscriptionHistory from '../models/SubscriptionHistory.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import { logAudit } from './auditService.js';
import { applyCapturedPayment } from './billingService.js';
import { upsertNotification } from './notificationService.js';
import { getProvider } from './payments/index.js';
import { getSubscription, resolveStatus } from './subscriptionService.js';

// BILLING SAFETY NET.
//
// Everything in here exists because money moves in more than one write. The engine's atomic claims
// make each individual step safe; nothing makes a *sequence* of steps safe against a restart. These
// jobs are what turn "a payment stuck halfway" from an invisible loss into a row that heals itself
// or an alert a human can act on.
//
// Registered in bootstrap/jobs.js on the existing scheduler, so each body runs once per window
// across the whole fleet (claimJob) rather than once per instance.

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A capture and its activation are milliseconds apart in the happy path. Anything still unfinished
// after this is not "in flight", it is stuck.
export const ACTIVATION_GRACE_MS = 10 * MINUTE_MS;

// Days before expiry a renewal reminder goes out. V1 has no auto-renew: if nobody tells the customer,
// their access simply stops. Ascending, because the stage that applies is the TIGHTEST window that
// has opened — a subscription 2 days out is told "in 3 days", not "in 7".
export const RENEWAL_REMINDER_DAYS = [1, 3, 7];

// How many rows one pass will touch. A sweep that tries to fix everything at once is a sweep that
// times out and fixes nothing.
const BATCH_LIMIT = 200;

/** Alert of last resort: the audit trail plus stderr. Both are already wired to monitoring. */
const alert = (business, action, metadata) => {
  console.error(`[billing] ${action}`, JSON.stringify(metadata));
  return logAudit(null, { business, action, resourceType: 'subscription', metadata });
};

// ---------------------------------------------------------------------------
// Captured but never activated
// ---------------------------------------------------------------------------

/**
 * Was the plan for this payment already applied?
 *
 * History is the direct evidence: a row tagged with this payment's id. It is written fire-and-forget
 * (a lost row must never fail a paid transition), so its absence does not prove anything on its own —
 * hence the state fallback below.
 *
 * **The state fallback does not apply to a renewal, and that distinction is load-bearing.** It asks
 * "is the subscription on this plan, with a period that started after this payment?" — which a LATER
 * cycle satisfies just as well as this one. Sequence that loses money: cycle 2's row is captured, its
 * activation dies, cycle 3 arrives and applies normally, and now `currentPeriodStart` is past cycle 2's
 * `createdAt`, so cycle 2 is written off as already applied. The customer paid for three months and
 * holds two. Pre-existing on the manual renewal path; monthly autopay makes it twelve times more likely.
 *
 * For a first purchase or an upgrade the fallback is still right: those move the plan or start the
 * period, so the state genuinely evidences them.
 *
 * The trade this accepts: if a renewal's history write is the thing that was lost, we re-apply and the
 * customer gets a month they did not pay for. Gifting a month is recoverable and visible in the audit
 * trail; silently swallowing a month they DID pay for is neither.
 */
const alreadyApplied = async (payment) => {
  const history = await SubscriptionHistory.findOne({
    business: payment.business,
    'metadata.paymentId': String(payment._id)
  }).lean();
  if (history) return true;

  if (payment.kind === 'renewal') return false;

  const subscription = await getSubscription(payment.business);
  return Boolean(
    subscription &&
      subscription.planKey === payment.planKey &&
      subscription.currentPeriodStart &&
      subscription.currentPeriodStart >= payment.createdAt
  );
};

/** Backfills the links `applyCapturedPayment` would have written, without touching the period. */
const backfillPaymentLinks = async (payment) => {
  const subscription = await getSubscription(payment.business);
  if (!subscription) return false;

  payment.subscription = subscription._id;
  payment.periodStart = payment.periodStart || subscription.currentPeriodStart;
  payment.periodEnd = payment.periodEnd || subscription.currentPeriodEnd;
  await payment.save();
  return true;
};

/**
 * Finishes payments that were captured but never became a subscription.
 *
 * The window: `activateFromPayment` flips the row to `captured` in one atomic update and then writes
 * the subscription in separate operations. A restart in between takes the customer's money, leaves no
 * plan, and — worst of all — makes every webhook retry return "already applied". `subscription: null`
 * is the marker, because that field is only set after the plan is applied.
 */
export const reconcileCapturedPayments = async ({ now = new Date(), graceMs = ACTIVATION_GRACE_MS } = {}) => {
  const stuck = await SubscriptionPayment.find({
    status: 'captured',
    subscription: null,
    updatedAt: { $lt: new Date(now.getTime() - graceMs) }
  })
    .sort({ updatedAt: 1 })
    .limit(BATCH_LIMIT);

  const result = { scanned: stuck.length, recovered: 0, backfilled: 0, failed: 0 };

  for (const payment of stuck) {
    try {
      if (await alreadyApplied(payment)) {
        if (await backfillPaymentLinks(payment)) result.backfilled += 1;
        continue;
      }

      await applyCapturedPayment({ claimed: payment, actor: { type: 'system', note: 'reconciliation' }, now });
      result.recovered += 1;

      void logAudit(null, {
        business: payment.business,
        action: 'billing.activation.recovered',
        resourceType: 'subscription',
        resourceId: String(payment._id),
        metadata: { planKey: payment.planKey, netAmount: payment.netAmount, receiptNumber: payment.receipt?.number || '' }
      });
    } catch (error) {
      result.failed += 1;
      // Money is captured and we still cannot grant the plan. This is the one billing state that
      // always needs a human: it is a customer who has paid and has nothing.
      await alert(payment.business, 'billing.activation.recovery_failed', {
        paymentId: String(payment._id),
        planKey: payment.planKey,
        netAmount: payment.netAmount,
        reason: error?.details?.code || error.message
      });
    }
  }

  return result;
};

/**
 * Payments whose activation failed for a reason no job can fix (the plan row is gone, the webhook
 * amount did not match). Nothing to retry — the point is that they keep being visible until someone
 * clears `failureReason`.
 */
export const reportActivationFailures = async ({ now = new Date(), graceMs = ACTIVATION_GRACE_MS } = {}) => {
  const failures = await SubscriptionPayment.find({
    status: 'captured',
    failureReason: { $gt: '' },
    updatedAt: { $lt: new Date(now.getTime() - graceMs) }
  })
    .sort({ updatedAt: 1 })
    .limit(BATCH_LIMIT)
    .lean();

  for (const payment of failures) {
    await alert(payment.business, 'billing.activation.needs_review', {
      paymentId: String(payment._id),
      planKey: payment.planKey,
      netAmount: payment.netAmount,
      receiptNumber: payment.receipt?.number || '',
      failureReason: payment.failureReason
    });
  }

  return { flagged: failures.length };
};

// ---------------------------------------------------------------------------
// Renewal and grace reminders
// ---------------------------------------------------------------------------
//
// upsertNotification is keyed on (business, notificationId), so an hourly sweep re-writing the same
// row is a no-op and pushes exactly once. That is what makes these jobs safe to run every hour
// without a "have I already told them?" flag anywhere.

const notificationIdFor = (parts) => parts.join(':').slice(0, 180);

const dayLabel = (days) => (days === 1 ? 'tomorrow' : `in ${days} days`);

/**
 * Warns a business before its plan lapses. Manual renewal is the V1 design, so this is not a nicety:
 * it is the only thing standing between a paying customer and silently losing access.
 */
export const sendRenewalReminders = async ({ now = new Date() } = {}) => {
  const horizon = new Date(now.getTime() + Math.max(...RENEWAL_REMINDER_DAYS) * DAY_MS);

  const due = await Subscription.find({
    currentPeriodEnd: { $gt: now, $lte: horizon },
    'cancel.effectiveAt': null
  })
    .limit(BATCH_LIMIT)
    .populate('business', 'name');

  let sent = 0;

  for (const subscription of due) {
    if (!['active', 'trialing'].includes(resolveStatus(subscription, now))) continue;

    // A working mandate will renew this by itself, and the provider sends its own pre-debit notice.
    // "Your plan ends tomorrow. Nothing is charged automatically." would be alarming AND false.
    //
    // Skipping rather than rewriting the copy is deliberate: every autopay failure state
    // (halted/pending/cancelled/completed) clears `enabled`, so those subscribers fall straight back
    // into this reminder — where the existing wording is true again.
    if (subscription.autopay?.enabled && subscription.autopay?.status === 'active') continue;

    const msLeft = subscription.currentPeriodEnd.getTime() - now.getTime();
    // The tightest stage whose window has opened — a subscription 2 days out gets the 3-day copy
    // once, then the 1-day copy, and never the 7-day one it already passed.
    const stage = RENEWAL_REMINDER_DAYS.find((days) => msLeft <= days * DAY_MS);
    if (!stage) continue;

    const businessId = subscription.business?._id || subscription.business;

    await upsertNotification({
      business: businessId,
      // The period end is in the key, so next period's reminders are new rows rather than a
      // resolved-and-reused one that would stay silent.
      notificationId: notificationIdFor(['subscription-renewal', String(subscription._id), subscription.currentPeriodEnd.toISOString(), stage]),
      type: 'subscription-renewal',
      resourceType: 'subscription',
      resourceId: subscription._id,
      tone: stage === 1 ? 'danger' : 'warning',
      title: `Your ${subscription.planKey} plan ends ${dayLabel(stage)}`,
      description: 'Renew to keep your current plan. Nothing is charged automatically.',
      to: '/subscription',
      sortDate: subscription.currentPeriodEnd,
      metadata: { planKey: subscription.planKey, stage, currentPeriodEnd: subscription.currentPeriodEnd }
    });

    sent += 1;
  }

  return { scanned: due.length, sent };
};

/**
 * Tells a business it is inside the grace window — the last chance to renew before entitlements fall
 * back to the free plan. One notification per period, refreshed daily by the upsert.
 */
export const sendGraceReminders = async ({ now = new Date() } = {}) => {
  const inGrace = await Subscription.find({
    currentPeriodEnd: { $lt: now },
    graceEndsAt: { $gt: now }
  }).limit(BATCH_LIMIT);

  let sent = 0;

  for (const subscription of inGrace) {
    if (resolveStatus(subscription, now) !== 'in_grace') continue;

    await upsertNotification({
      business: subscription.business,
      notificationId: notificationIdFor(['subscription-grace', String(subscription._id), subscription.currentPeriodEnd.toISOString()]),
      type: 'subscription-grace',
      resourceType: 'subscription',
      resourceId: subscription._id,
      tone: 'danger',
      title: 'Your plan has expired',
      description: `You keep full access until ${subscription.graceEndsAt.toDateString()}. Renew now to avoid losing it.`,
      to: '/subscription',
      sortDate: subscription.graceEndsAt,
      metadata: { planKey: subscription.planKey, graceEndsAt: subscription.graceEndsAt }
    });

    sent += 1;
  }

  return { scanned: inGrace.length, sent };
};

// ---------------------------------------------------------------------------
// Autopay
// ---------------------------------------------------------------------------

// How far ahead a customer is told about an upcoming automatic debit. Courtesy, not compliance: the
// provider sends the regulator-mandated pre-debit notification (`customer_notify`).
export const AUTOPAY_NOTICE_DAYS = 3;

// A charge event moves `nextDebitAt` forward. One that is this far in the past means we never saw the
// charge — either it did not happen or its event was lost.
export const AUTOPAY_STALE_DEBIT_MS = 2 * DAY_MS;

/** "We will debit you on the Nth" — so an automatic charge is never a surprise on a statement. */
export const sendAutopayDebitNotices = async ({ now = new Date() } = {}) => {
  const horizon = new Date(now.getTime() + AUTOPAY_NOTICE_DAYS * DAY_MS);

  const due = await Subscription.find({
    'autopay.enabled': true,
    'autopay.nextDebitAt': { $gt: now, $lte: horizon }
  }).limit(BATCH_LIMIT);

  let sent = 0;

  for (const subscription of due) {
    if (subscription.autopay.status !== 'active') continue;

    await upsertNotification({
      business: subscription.business,
      // The debit instant is in the key, so each cycle is its own notification and re-sweeps are free.
      notificationId: notificationIdFor(['autopay-debit', String(subscription._id), subscription.autopay.nextDebitAt.toISOString()]),
      type: 'autopay-debit-upcoming',
      resourceType: 'subscription',
      resourceId: subscription._id,
      tone: 'info',
      title: `Your ${subscription.planKey} plan renews on ${subscription.autopay.nextDebitAt.toDateString()}`,
      description: 'Autopay will take this automatically. Turn autopay off any time from Plan & billing.',
      to: '/subscription',
      sortDate: subscription.autopay.nextDebitAt,
      metadata: {
        planKey: subscription.planKey,
        amount: subscription.autopay.chargeAmount,
        nextDebitAt: subscription.autopay.nextDebitAt
      }
    });

    sent += 1;
  }

  return { scanned: due.length, sent };
};

/**
 * Finds mandates that have gone quiet: we believe they are live, but no charge has arrived when one
 * was due. Either the provider stopped and we missed the terminal event, or it charged and we missed
 * that event — the second case is a customer who paid and got nothing.
 *
 * **Never grants a period.** A period comes only from a charge with a payment id (see
 * autopayService), so this job alerts and re-syncs the mirror; a human or a redelivered event
 * finishes the job.
 *
 * ponytail: detect-and-alert. Auto-healing would mean reading the provider's own invoice list and
 * minting rows from it — worth building only if this fires often enough to matter.
 */
export const reconcileAutopayMandates = async ({ now = new Date() } = {}) => {
  const stale = await Subscription.find({
    'autopay.enabled': true,
    'autopay.nextDebitAt': { $lt: new Date(now.getTime() - AUTOPAY_STALE_DEBIT_MS) }
  }).limit(BATCH_LIMIT);

  let alerted = 0;
  let mirrored = 0;

  for (const subscription of stale) {
    const providerSubscriptionId = subscription.provider?.subscriptionId;
    if (!providerSubscriptionId) continue;

    let remote;
    try {
      remote = await getProvider(subscription.provider?.name || undefined).fetchSubscription(providerSubscriptionId);
    } catch (error) {
      // A provider outage is not a billing incident. Next sweep tries again.
      console.error(`[billing] could not read mandate ${providerSubscriptionId}:`, error.message);
      continue;
    }

    // `halted` belongs here too: it is terminal for autopay even though the mandate technically still
    // exists at the provider. Leaving it out meant a halted mandate whose webhook was lost got treated
    // as "still live but silent" and alerted ops every hour instead of being mirrored.
    if (['halted', 'cancelled', 'completed', 'expired'].includes(remote.status)) {
      await Subscription.updateOne(
        { _id: subscription._id },
        {
          $set: {
            'autopay.enabled': false,
            'autopay.status': remote.status === 'expired' ? 'cancelled' : remote.status,
            ...(remote.status === 'halted' ? {} : { 'autopay.cancelledAt': subscription.autopay.cancelledAt || now }),
            'autopay.nextDebitAt': null
          }
        }
      );

      // Same notice the halted webhook would have raised — the customer has to act either way, and
      // upsertNotification's key means they are not told twice if the event later arrives.
      if (remote.status === 'halted') {
        await upsertNotification({
          business: subscription.business,
          notificationId: notificationIdFor(['autopay-halted', String(subscription._id), 'reconciled']),
          type: 'autopay-halted',
          resourceType: 'subscription',
          resourceId: subscription._id,
          tone: 'danger',
          title: 'Automatic payment stopped',
          description: 'Your bank stopped the automatic payment. Renew manually to keep your plan, then turn autopay back on.',
          to: '/subscription',
          sortDate: now
        });
      }

      mirrored += 1;
      continue;
    }

    // Still live at the provider but silent here. Refresh the clock FIRST so this does not re-alert
    // every hour on the same fact, then say so once.
    await Subscription.updateOne(
      { _id: subscription._id },
      { $set: { 'autopay.nextDebitAt': remote.chargeAt || null, 'autopay.status': 'active' } }
    );

    await alert(subscription.business, 'billing.autopay.charge_missing', {
      subscriptionId: String(subscription._id),
      providerSubscriptionId,
      providerStatus: remote.status,
      providerPaidCount: remote.paidCount,
      expectedDebitAt: subscription.autopay.nextDebitAt,
      providerChargeAt: remote.chargeAt
    });
    alerted += 1;
  }

  return { scanned: stale.length, alerted, mirrored };
};

/** One entry point for the scheduler, so a failure in one sweep cannot skip the others. */
export const runBillingReconciliation = async ({ now = new Date() } = {}) => {
  const settled = await Promise.allSettled([
    reconcileCapturedPayments({ now }),
    reportActivationFailures({ now }),
    sendRenewalReminders({ now }),
    sendGraceReminders({ now }),
    sendAutopayDebitNotices({ now }),
    reconcileAutopayMandates({ now })
  ]);

  return settled.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : { error: outcome.reason?.message || 'failed' }));
};
