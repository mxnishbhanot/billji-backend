import Business from '../models/Business.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import SubscriptionHistory from '../models/SubscriptionHistory.js';
import { DEFAULT_PLAN_KEY } from '../constants/entitlements.js';
import { ApiError } from '../utils/ApiError.js';
import { getDefaultPlan, planEntitlements, resolveEntitlements } from './entitlementService.js';

// SUBSCRIPTION SNAPSHOT ENGINE.
//
// Owns the lifecycle of the Subscription document: creation, plan application (which is where the
// snapshot is taken), status resolution and the history trail.
//
// BillJi decides everything here. No provider is imported, mentioned or consulted — a payment
// processor's only job is to confirm that money moved, and that confirmation arrives in Phase 3
// as a call into applyPlan(). Swapping Razorpay for Stripe changes nothing in this file.

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Copies a plan's entitlements into an immutable snapshot.
 *
 * The whole design rests on this being a copy. Editing the Pro plan tomorrow must not change what
 * a customer who bought Pro today is entitled to; a snapshot is the only way to guarantee that,
 * and it is what makes grandfathering, price-for-life, per-customer enterprise terms and (later)
 * add-ons and build-your-own-plan expressible without a schema change.
 */
export const buildSnapshot = (plan) => {
  if (!plan) throw new Error('buildSnapshot requires a plan');
  const { features, limits } = planEntitlements(plan);
  return { features, limits };
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The effective status, derived from dates on every read.
 *
 * Never trust the stored `status` for an access decision: a subscription that expired at midnight
 * is expired at 00:00:01, not whenever a cron job next runs. The stored value records intent at
 * the last transition; this function reports reality. Jobs exist only for side effects (dunning
 * email, notifications), never to make this correct.
 */
export const resolveStatus = (subscription, now = new Date()) => {
  if (!subscription) return 'none';
  // Schema-only state; nothing sets it yet. Honoured here so enabling pause later is a service
  // change, not a hunt through call sites.
  if (subscription.status === 'paused') return 'paused';

  const cancelledAt = subscription.cancel?.effectiveAt;
  if (cancelledAt && cancelledAt <= now) return 'cancelled';

  const trialEndsAt = subscription.trial?.endsAt;
  if (subscription.status === 'trialing' && trialEndsAt) {
    if (trialEndsAt > now) return 'trialing';
    // Trial is over and no payment converted it: fall back, do not lock out.
    return 'expired';
  }

  const periodEnd = subscription.currentPeriodEnd;
  // null = free, lifetime or grandfathered. Never expires.
  if (!periodEnd) return 'active';
  if (periodEnd > now) return 'active';

  const graceEndsAt = subscription.graceEndsAt;
  if (graceEndsAt && graceEndsAt > now) return 'in_grace';

  return 'expired';
};

/** True while the customer still has what they paid for (including the grace window). */
export const isEntitled = (subscription, now = new Date()) =>
  ['trialing', 'active', 'in_grace', 'past_due'].includes(resolveStatus(subscription, now));

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const getSubscription = (businessId) => Subscription.findOne({ business: businessId });

/**
 * Everything a caller needs to make access decisions, in one object.
 *
 * Falls back to the default plan's entitlements when a subscription is expired, cancelled or
 * missing — a lapsed customer must still be able to open their own invoices. Returning nothing
 * would lock people out of their own data over a billing lapse, which is never the right answer.
 */
export const resolveAccess = async ({ business, subscription = null, now = new Date() }) => {
  const businessId = business?._id || business;
  const sub = subscription || (await getSubscription(businessId));
  const status = resolveStatus(sub, now);
  const needsFallback = !['trialing', 'active', 'in_grace', 'past_due'].includes(status);
  const fallbackPlan = needsFallback ? await getDefaultPlan() : null;

  const entitlements = resolveEntitlements({
    subscription: sub,
    effectiveStatus: status,
    fallback: fallbackPlan ? planEntitlements(fallbackPlan) : null,
    now
  });

  return {
    subscription: sub,
    status,
    entitlements,
    planId: sub?.plan || fallbackPlan?._id || null,
    // Display and analytics only. Never branch on this.
    planKey: needsFallback ? fallbackPlan?.key || DEFAULT_PLAN_KEY : sub?.planKey || DEFAULT_PLAN_KEY,
    isTrial: status === 'trialing',
    inGrace: status === 'in_grace',
    currentPeriodEnd: sub?.currentPeriodEnd || null,
    graceEndsAt: sub?.graceEndsAt || null,
    trialEndsAt: sub?.trial?.endsAt || null
  };
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const recordHistory = (entry) =>
  SubscriptionHistory.create(entry).catch((error) => {
    // History is forensics, not a gate. Losing a row must never fail the transition that
    // produced it — a customer who paid gets access even if the audit write hiccups.
    console.error('[billing] failed to write SubscriptionHistory:', error.message);
  });

/**
 * Keeps the denormalized Business.plan mirror in step. Legacy readers (teamLimitService and any
 * older mobile build) still read it, so it must never drift from the subscription.
 */
export const syncBusinessMirror = (subscription, status) =>
  Business.updateOne(
    { _id: subscription.business },
    { $set: { 'plan.key': subscription.planKey, 'plan.subscriptionStatus': status, 'plan.updatedAt': new Date() } }
  );

const periodEndFor = ({ interval, intervalCount = 1, from }) => {
  const end = new Date(from);
  switch (interval) {
    case 'month':
      end.setMonth(end.getMonth() + intervalCount);
      return end;
    case 'year':
      end.setFullYear(end.getFullYear() + intervalCount);
      return end;
    // free, lifetime, custom: no expiry. Enterprise terms are set explicitly by an admin.
    default:
      return null;
  }
};

/**
 * Applies a plan to a business: takes a fresh snapshot, sets the period, writes history and
 * refreshes the mirror. Every paid transition in later phases (activation, renewal, upgrade,
 * downgrade, admin assignment) funnels through here, so the snapshot rule cannot be bypassed
 * by adding a new flow.
 *
 * Period dates are computed by BillJi from the interval — never read back from a provider.
 */
export const applyPlan = async ({
  business,
  plan,
  interval = null,
  action = 'activated',
  actor = { type: 'system' },
  now = new Date(),
  amount = null,
  currency = null,
  lockPricing = false,
  periodEnd: explicitPeriodEnd = undefined,
  metadata = {}
}) => {
  const businessId = business?._id || business;
  if (!plan) throw new Error('applyPlan requires a plan');

  const existing = await getSubscription(businessId);
  const price = interval ? plan.priceFor(interval) : plan.prices?.find((candidate) => candidate.status === 'active') || null;
  const effectiveInterval = interval || price?.interval || 'free';
  const snapshot = buildSnapshot(plan);

  // A renewal extends from the end of the period already paid for, not from today: a customer who
  // renews three days early must not lose those three days. Every other transition (activation,
  // upgrade, downgrade, admin assignment) starts a fresh period now.
  const stillRunning = existing?.currentPeriodEnd && existing.currentPeriodEnd > now;
  const extendFrom = action === 'renewed' && stillRunning ? existing.currentPeriodEnd : now;
  const periodStart = now;
  const periodEnd =
    explicitPeriodEnd !== undefined
      ? explicitPeriodEnd
      : periodEndFor({ interval: effectiveInterval, intervalCount: price?.intervalCount || 1, from: extendFrom });
  const graceDays = plan.grace?.days || 0;
  const graceEndsAt = periodEnd && graceDays > 0 ? new Date(periodEnd.getTime() + graceDays * DAY_MS) : periodEnd;

  const before = existing
    ? { planKey: existing.planKey, status: resolveStatus(existing, now), snapshot: existing.entitlements }
    : null;

  // Price already agreed with this customer wins over the plan's current price: a founding-member
  // or negotiated rate must survive every renewal and every future price rise.
  const keepLockedPrice = existing?.pricing?.locked && amount === null;

  const fields = {
    plan: plan._id,
    planKey: plan.key,
    planVersion: plan.version || 1,
    status: 'active',
    billingInterval: effectiveInterval,
    entitlements: snapshot,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    graceEndsAt,
    ...(keepLockedPrice
      ? {}
      : {
          'pricing.amount': amount ?? price?.amount ?? 0,
          'pricing.compareAtAmount': price?.compareAtAmount ?? 0,
          'pricing.currency': currency || price?.currency || 'INR',
          'pricing.locked': lockPricing || Boolean(existing?.pricing?.locked)
        }),
    // A new plan supersedes any pending cancellation.
    'cancel.requestedAt': null,
    'cancel.effectiveAt': null
  };

  const subscription = await Subscription.findOneAndUpdate(
    { business: businessId },
    { $set: fields, $setOnInsert: { business: businessId } },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
  );

  await syncBusinessMirror(subscription, 'active');
  await recordHistory({
    business: businessId,
    subscription: subscription._id,
    action: existing ? action : 'created',
    fromPlanKey: before?.planKey || '',
    toPlanKey: plan.key,
    fromStatus: before?.status || '',
    toStatus: 'active',
    effectiveAt: periodStart,
    amount: fields['pricing.amount'] ?? subscription.pricing?.amount ?? 0,
    currency: subscription.pricing?.currency || 'INR',
    snapshotBefore: before?.snapshot || null,
    snapshotAfter: snapshot,
    actor,
    metadata: { interval: effectiveInterval, planVersion: plan.version, ...metadata }
  });

  return subscription;
};

/**
 * Get-or-create. Called on signup and defensively anywhere a subscription is assumed — a business
 * without one is a data hole that would otherwise surface as a crash on an access check.
 * Idempotent, so it is safe on every request path and safe to re-run as a backfill.
 */
export const ensureSubscription = async ({ business, planKey = null, actor = { type: 'system' }, now = new Date() }) => {
  const businessId = business?._id || business;
  const existing = await getSubscription(businessId);
  if (existing) return existing;

  const plan = planKey ? await Plan.findOne({ key: planKey }) : await getDefaultPlan();
  if (!plan) throw new Error(`Cannot create a subscription: no plan found (${planKey || 'default'}). Run the billing seeder.`);

  return applyPlan({ business: businessId, plan, action: 'created', actor, now });
};

/**
 * Starts a no-card trial on a plan.
 *
 * A trial is a snapshot like any other — the trialling business genuinely holds the paid plan's
 * entitlements — with an end date and a one-shot `trial.used` latch. Once per business, ever: the
 * latch is on the subscription, so switching plans does not hand out a second trial.
 */
export const startTrial = async ({ business, plan, actor = { type: 'user' }, extraMs = 0, now = new Date() }) => {
  const businessId = business?._id || business;
  if (!plan?.trial?.enabled || !(plan.trial.days > 0)) {
    throw new ApiError(400, 'That plan does not offer a trial', { code: 'TRIAL_NOT_AVAILABLE' });
  }

  const existing = await getSubscription(businessId);
  if (existing?.trial?.used) {
    throw new ApiError(409, 'This business has already used its trial', { code: 'TRIAL_ALREADY_USED' });
  }
  if (existing && ['active', 'in_grace'].includes(resolveStatus(existing, now)) && existing.currentPeriodEnd) {
    throw new ApiError(409, 'You already have a paid subscription', { code: 'SUBSCRIPTION_ALREADY_PAID' });
  }

  const endsAt = new Date(now.getTime() + plan.trial.days * DAY_MS + extraMs);
  const snapshot = buildSnapshot(plan);
  const before = existing ? { planKey: existing.planKey, status: resolveStatus(existing, now), snapshot: existing.entitlements } : null;

  const subscription = await Subscription.findOneAndUpdate(
    { business: businessId },
    {
      $set: {
        plan: plan._id,
        planKey: plan.key,
        planVersion: plan.version || 1,
        status: 'trialing',
        billingInterval: 'free',
        entitlements: snapshot,
        currentPeriodStart: now,
        // A trial's expiry lives in trial.endsAt; currentPeriodEnd stays null so that nothing
        // mistakes an unpaid trial for a paid period.
        currentPeriodEnd: null,
        graceEndsAt: null,
        trial: { used: true, startedAt: now, endsAt, planKey: plan.key },
        'pricing.amount': 0,
        'cancel.requestedAt': null,
        'cancel.effectiveAt': null
      },
      $setOnInsert: { business: businessId }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  await syncBusinessMirror(subscription, 'trialing');
  await recordHistory({
    business: businessId,
    subscription: subscription._id,
    action: 'trial_started',
    fromPlanKey: before?.planKey || '',
    toPlanKey: plan.key,
    fromStatus: before?.status || '',
    toStatus: 'trialing',
    effectiveAt: now,
    snapshotBefore: before?.snapshot || null,
    snapshotAfter: snapshot,
    actor,
    metadata: { trialDays: plan.trial.days, endsAt }
  });

  return subscription;
};

/**
 * Cancels. By default access continues to the end of the period already paid for — taking it away
 * the moment someone clicks cancel would be keeping money for time not served.
 */
export const cancelSubscription = async ({ business, reason = '', immediate = false, actor = { type: 'user' }, now = new Date() }) => {
  const businessId = business?._id || business;
  const subscription = await getSubscription(businessId);
  if (!subscription) throw new ApiError(404, 'No subscription to cancel', { code: 'SUBSCRIPTION_NOT_FOUND' });

  const status = resolveStatus(subscription, now);
  if (['cancelled', 'expired'].includes(status)) {
    throw new ApiError(409, 'This subscription is already cancelled', { code: 'SUBSCRIPTION_ALREADY_CANCELLED' });
  }

  // Nothing paid for (free plan or trial) has no remaining period to honour, so it ends now.
  const paidUntil = subscription.currentPeriodEnd;
  const effectiveAt = immediate || !paidUntil || paidUntil <= now ? now : paidUntil;

  subscription.cancel = { requestedAt: now, effectiveAt, atPeriodEnd: !immediate && effectiveAt > now, reason: String(reason).slice(0, 500) };
  await subscription.save();

  const toStatus = resolveStatus(subscription, now);
  await syncBusinessMirror(subscription, toStatus);
  await recordHistory({
    business: businessId,
    subscription: subscription._id,
    action: 'cancelled',
    fromPlanKey: subscription.planKey,
    toPlanKey: subscription.planKey,
    fromStatus: status,
    toStatus,
    effectiveAt,
    snapshotBefore: subscription.entitlements,
    snapshotAfter: subscription.entitlements,
    actor,
    metadata: { immediate, reason: String(reason).slice(0, 500) }
  });

  return subscription;
};

/** Undoes a cancellation that has not taken effect yet. Past that point it is a new purchase. */
export const reactivateSubscription = async ({ business, actor = { type: 'user' }, now = new Date() }) => {
  const businessId = business?._id || business;
  const subscription = await getSubscription(businessId);
  if (!subscription?.cancel?.effectiveAt) {
    throw new ApiError(409, 'This subscription is not scheduled to cancel', { code: 'SUBSCRIPTION_NOT_CANCELLING' });
  }
  if (subscription.cancel.effectiveAt <= now) {
    throw new ApiError(409, 'This subscription has already ended. Choose a plan to start again.', {
      code: 'SUBSCRIPTION_ALREADY_ENDED'
    });
  }

  const fromStatus = resolveStatus(subscription, now);
  subscription.cancel = { requestedAt: null, effectiveAt: null, atPeriodEnd: true, reason: '' };
  await subscription.save();

  await syncBusinessMirror(subscription, resolveStatus(subscription, now));
  await recordHistory({
    business: businessId,
    subscription: subscription._id,
    action: 'reactivated',
    fromPlanKey: subscription.planKey,
    toPlanKey: subscription.planKey,
    fromStatus,
    toStatus: resolveStatus(subscription, now),
    effectiveAt: now,
    actor
  });

  return subscription;
};

/**
 * Re-copies the current plan into an existing subscription's snapshot.
 *
 * The explicit, auditable opt-in that lets an admin push a corrected plan to existing subscribers.
 * Editing a plan deliberately does NOT do this — that is the entire point of the snapshot.
 */
export const resnapshot = async ({ subscription, actor = { type: 'admin' }, now = new Date() }) => {
  const plan = await Plan.findById(subscription.plan);
  if (!plan) throw new Error(`Subscription ${subscription._id} references a missing plan`);

  const before = subscription.entitlements;
  const snapshot = buildSnapshot(plan);

  subscription.entitlements = snapshot;
  subscription.planVersion = plan.version || 1;
  subscription.planKey = plan.key;
  await subscription.save();

  await recordHistory({
    business: subscription.business,
    subscription: subscription._id,
    action: 'resnapshot',
    fromPlanKey: plan.key,
    toPlanKey: plan.key,
    fromStatus: resolveStatus(subscription, now),
    toStatus: resolveStatus(subscription, now),
    snapshotBefore: before,
    snapshotAfter: snapshot,
    actor
  });

  return subscription;
};
