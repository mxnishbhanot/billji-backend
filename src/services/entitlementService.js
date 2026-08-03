import { DEFAULT_PLAN_KEY, UNLIMITED, isFeatureKey, isLimitKey, limitDefinition } from '../constants/entitlements.js';
import Plan from '../models/Plan.js';

// FEATURE + LIMIT ENGINE.
//
// The only place in the codebase allowed to answer "can this business do X?" and "how much of Y
// is it allowed?". Everything else calls canAccessFeature() / getLimit() with a catalog key.
//
// Nothing here reads a plan name. Nothing here reads the live Plan document for an active
// subscriber either — entitlements come from the subscription snapshot, so an admin editing a
// plan cannot retroactively change what an existing subscriber bought.

/** Statuses that still grant the plan the customer paid for. `in_grace` deliberately included. */
const ENTITLED_STATUSES = new Set(['trialing', 'active', 'in_grace', 'past_due']);

const asObject = (mapOrObject) => {
  if (!mapOrObject) return {};
  if (mapOrObject instanceof Map) return Object.fromEntries(mapOrObject);
  // Mongoose sub-document holding Maps.
  if (typeof mapOrObject.toObject === 'function') return asObject(mapOrObject.toObject());
  return { ...mapOrObject };
};

// ---------------------------------------------------------------------------
// Default-plan fallback
// ---------------------------------------------------------------------------
//
// An expired or cancelled subscription falls back to the default plan rather than to nothing:
// a lapsed customer must still be able to open their own invoices. The default plan's
// entitlements are the one thing that cannot come from a snapshot, so they are read from the
// Plan collection behind a short TTL cache. Plans are a handful of rows that change rarely.
//
// ponytail: process-local cache, 60s TTL. Deliberately not shared/invalidated across the fleet
// — a 60s lag on a plan edit is harmless. If plans ever become hot-edited, move to a pub/sub
// invalidation rather than growing the TTL.
const PLAN_CACHE_TTL_MS = 60 * 1000;
let defaultPlanCache = { value: null, at: 0 };

export const clearPlanCache = () => {
  defaultPlanCache = { value: null, at: 0 };
};

export const getDefaultPlan = async (now = Date.now()) => {
  if (defaultPlanCache.value && now - defaultPlanCache.at < PLAN_CACHE_TTL_MS) {
    return defaultPlanCache.value;
  }

  const plan =
    (await Plan.findOne({ isDefault: true, status: 'active' })) || (await Plan.findOne({ key: DEFAULT_PLAN_KEY }));

  if (plan) defaultPlanCache = { value: plan, at: now };
  return plan;
};

/**
 * The entitlements a plan hands out. Used when snapshotting and as the expired-subscription
 * fallback — the two places where a live plan is legitimately read.
 */
export const planEntitlements = (plan) => ({
  features: asObject(plan?.features),
  limits: asObject(plan?.limits)
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Effective entitlements for a subscription, in precedence order:
 *
 *   snapshot  ->  add-on grants  ->  per-customer overrides
 *
 * Add-ons are merged here (not implemented, but the merge is one line and proves the shape
 * needs no schema change later). Overrides win last so support/sales can always fix a case.
 *
 * `effectiveStatus` must be passed in by the caller (subscriptionService.resolveStatus) rather
 * than read off the document, because a stored status lags reality until something writes to it.
 */
export const resolveEntitlements = ({ subscription, effectiveStatus, fallback = null, now = new Date() }) => {
  if (!subscription || !ENTITLED_STATUSES.has(effectiveStatus)) {
    return {
      features: asObject(fallback?.features),
      limits: asObject(fallback?.limits),
      source: subscription ? 'fallback' : 'none'
    };
  }

  const snapshot = subscription.entitlements || {};
  const features = asObject(snapshot.features);
  const limits = asObject(snapshot.limits);

  for (const addOn of subscription.addOns || []) {
    if (addOn.status !== 'active') continue;
    if (addOn.expiresAt && addOn.expiresAt <= now) continue;
    Object.assign(features, asObject(addOn.grants?.features));
    // Numeric add-on grants add to the ceiling (extra seats, extra storage) rather than replace it.
    for (const [key, value] of Object.entries(asObject(addOn.grants?.limits))) {
      const quantity = addOn.quantity || 1;
      limits[key] = isUnlimited(limits[key]) || isUnlimited(value) ? UNLIMITED : (limits[key] || 0) + value * quantity;
    }
  }

  Object.assign(features, asObject(subscription.overrides?.features));
  Object.assign(limits, asObject(subscription.overrides?.limits));

  return { features, limits, source: 'snapshot' };
};

// ---------------------------------------------------------------------------
// Public helpers — the only API the rest of the app should use
// ---------------------------------------------------------------------------

export const isUnlimited = (value) => value === UNLIMITED || value === null || value === undefined;

/**
 * @param {{features: object}} entitlements resolved entitlements
 * @param {string} featureKey a key from constants/entitlements.js
 */
export const canAccessFeature = (entitlements, featureKey) => {
  if (!isFeatureKey(featureKey)) {
    // A typo'd key must fail loudly at development time, not silently grant or deny in production.
    throw new Error(`Unknown feature key: ${featureKey}. Add it to constants/entitlements.js.`);
  }
  return Boolean(entitlements?.features?.[featureKey]);
};

/** Non-boolean feature values (a tier name, a count) for features that need more than on/off. */
export const featureValue = (entitlements, featureKey) => {
  if (!isFeatureKey(featureKey)) throw new Error(`Unknown feature key: ${featureKey}`);
  return entitlements?.features?.[featureKey];
};

/** An absent limit means no ceiling — a newly added limit key must never block anyone by surprise. */
export const getLimit = (entitlements, limitKey) => {
  if (!isLimitKey(limitKey)) throw new Error(`Unknown limit key: ${limitKey}. Add it to constants/entitlements.js.`);
  const value = entitlements?.limits?.[limitKey];
  return value === undefined || value === null ? UNLIMITED : value;
};

/**
 * Cheapest plans that grant a feature, for the 402 response body and the upgrade sheet.
 * Computed by scanning plans — never a hardcoded "requires Pro" string.
 */
export const plansGrantingFeature = async (featureKey) => {
  if (!isFeatureKey(featureKey)) throw new Error(`Unknown feature key: ${featureKey}`);

  const plans = await Plan.find({ status: 'active', visibility: 'public' }).sort({ sortOrder: 1 });
  return plans
    .filter((plan) => Boolean(plan.features?.get(featureKey)))
    .map((plan) => ({
      planId: plan._id,
      planKey: plan.key,
      name: plan.name,
      prices: plan.prices.filter((price) => price.status === 'active').map((price) => ({ interval: price.interval, amount: price.amount, currency: price.currency }))
    }));
};

/** Metadata for a limit key (label, unit, period, metered) — display and engine wiring. */
export const describeLimit = (limitKey) => limitDefinition(limitKey);
