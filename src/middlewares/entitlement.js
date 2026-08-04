import { LIMITS, UNLIMITED } from '../constants/entitlements.js';
import { env } from '../config/env.js';
import Plan from '../models/Plan.js';
import { logAudit } from '../services/auditService.js';
import { canAccessFeature, getLimit, isUnlimited, plansGrantingFeature } from '../services/entitlementService.js';
import { checkLimit, decrementUsage, incrementUsage, recordOverage, usesFallbackQuota } from '../services/usageService.js';
import { ApiError } from '../utils/ApiError.js';

// SUBSCRIPTION ENFORCEMENT.
//
// The only place in the codebase allowed to turn an entitlement into a refusal. Everything else
// calls requireFeature() / requireLimit() / meterDocument() and never sees a plan, a mode or a
// status code.
//
// Nothing here re-implements permissions: RBAC answers "is this person allowed?" (403), this
// answers "did this business buy it?" (402). A request passes both or neither, in that order —
// requirePermission first on every route, so a viewer is refused for being a viewer, not for
// being on Starter.
//
// Three modes, from BILLING_ENFORCEMENT:
//   off  — never blocks, never warns. Byte-for-byte today's behaviour.
//   warn — never blocks. Records the overage, attaches warning metadata, audits the would-be
//          block. This is how a limit is proven safe before it is switched on.
//   on   — blocks with 402 and the cheapest plans that would grant the thing.
//
// The one thing no mode may do is reject an already-issued document at sync time (§offline).

export const ENFORCEMENT_MODES = ['off', 'warn', 'on'];

/**
 * Read per call, not at import: enforcement is flipped by an env change plus a restart in
 * production, and by a single assignment in tests. An unrecognised value reads as `off` —
 * a typo'd flag must never start blocking paying customers.
 */
export const enforcementMode = () => {
  const value = String(process.env.BILLING_ENFORCEMENT ?? env.billing.enforcement ?? 'off').toLowerCase();
  return ENFORCEMENT_MODES.includes(value) ? value : 'off';
};

// ---------------------------------------------------------------------------
// Warning metadata
// ---------------------------------------------------------------------------

/**
 * Attaches a warning to the response without any controller knowing.
 *
 * `res.json` is wrapped once per response and merges `billingWarnings` into the envelope, so
 * warn mode adds a field to every existing endpoint and changes no controller. The array also
 * stays on the request, which is how the sync path (whose response is captured, not sent)
 * reports the same warnings per operation.
 */
export const attachBillingWarning = (req, res, warning) => {
  if (!warning) return warning;

  // Own property on purpose: on a sync sub-request this keeps the warnings scoped to the one
  // operation instead of leaking into the rest of the batch.
  if (!Object.prototype.hasOwnProperty.call(req, 'billingWarnings')) req.billingWarnings = [];
  req.billingWarnings.push(warning);

  if (res && !res.__billingWarningsPatched) {
    res.__billingWarningsPatched = true;
    const json = res.json.bind(res);
    res.json = (body) =>
      json(body && typeof body === 'object' && !Array.isArray(body) ? { ...body, billingWarnings: req.billingWarnings } : body);
  }

  return warning;
};

export const billingWarningsFor = (req) =>
  Object.prototype.hasOwnProperty.call(req, 'billingWarnings') ? req.billingWarnings : [];

// Analytics on every would-be block — the whole point of warn mode is knowing what `on` would
// have cost before switching it on. AuditLog is already the append-only trail for this business,
// so this needs no new collection and no new pipeline.
const recordEnforcementEvent = (req, { action, metadata }) =>
  void logAudit(req, { action, resourceType: 'subscription', metadata });

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

const featureFailure = async ({ featureKey, access }) => ({
  code: 'FEATURE_NOT_IN_PLAN',
  feature: featureKey,
  currentPlan: access.planKey,
  subscriptionStatus: access.status,
  requiredPlans: await plansGrantingFeature(featureKey)
});

/**
 * Core feature check, express-free so the sync registry uses the very same code path.
 *
 * Returns `{ allowed, blocked, warning }`. Throws only in `on` mode — a caller that wants to
 * decide for itself (the offline path) reads the result instead.
 *
 * `offline: true` extends the offline rule (approved Decision 3) from limits to features, for the same
 * reason it exists for limits: the record was already created on a device, in good faith, by someone
 * who had no way to ask. Refusing it at sync time does not undo the work — it strands the row on that
 * device forever and loses it at the next reinstall. So it is accepted, flagged and audited.
 *
 * The trade-off, stated plainly: a modified client could push a feature the business never bought.
 * That is visible in the audit log as `billing.feature.overage_offline`, the app's own UI never offers
 * the screen, and online enforcement is untouched — which is a better bargain than deleting a
 * customer's expenses to protect a paywall.
 */
export const checkFeatureAccess = async ({ req, res = null, featureKey, throwOnBlock = true, offline = false }) => {
  const mode = enforcementMode();
  if (mode === 'off') return { allowed: true, blocked: false, warning: null };

  const access = await req.access();
  if (canAccessFeature(access.entitlements, featureKey)) return { allowed: true, blocked: false, warning: null };

  const details = await featureFailure({ featureKey, access });
  const message = `Your ${details.currentPlan} plan does not include this feature.`;

  if (offline) {
    const offlineDetails = { ...details, code: 'FEATURE_NOT_IN_PLAN_OFFLINE' };
    recordEnforcementEvent(req, { action: 'billing.feature.overage_offline', metadata: offlineDetails });
    return {
      allowed: true,
      blocked: false,
      warning: attachBillingWarning(req, res, {
        ...offlineDetails,
        message: 'This was created offline and is not included in your plan. Upgrade to keep using it.'
      })
    };
  }

  if (mode === 'on') {
    recordEnforcementEvent(req, { action: 'billing.feature.blocked', metadata: details });
    if (throwOnBlock) throw new ApiError(402, message, details);
    return { allowed: false, blocked: true, warning: null, details, message };
  }

  recordEnforcementEvent(req, { action: 'billing.feature.warned', metadata: details });
  return { allowed: true, blocked: false, warning: attachBillingWarning(req, res, { ...details, message }) };
};

/** Route guard. Mount after requirePermission — permission first, then plan. */
export const requireFeature = (featureKey) => async (req, res, next) => {
  try {
    await checkFeatureAccess({ req, res, featureKey });
    return next();
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------------------
// Limits — live-counted (team members, businesses, products…)
// ---------------------------------------------------------------------------

const limitFailure = ({ limitKey, result, access }) => ({
  code: 'LIMIT_REACHED',
  limit: isUnlimited(result.limit) ? null : result.limit,
  metric: limitKey,
  used: result.used,
  currentPlan: access.planKey,
  subscriptionStatus: access.status,
  resetsAt: result.resetsAt || null
});

/**
 * Checks a limit that is counted live against the real collection (LIMIT_DEFINITIONS.metered
 * false). `used` is the current count — the caller owns that query, because only it knows what
 * occupancy means for its entity (teamLimitService counts members plus pending invites).
 */
export const checkLimitAllowed = async ({ req, res = null, limitKey, used, amount = 1, throwOnBlock = true }) => {
  const mode = enforcementMode();
  const access = await req.access();
  const result = await checkLimit({ business: req.business._id, entitlements: access.entitlements, limitKey, used, amount });

  if (result.allowed || mode === 'off') return { ...result, allowed: true, blocked: false, warning: null };

  const details = { ...limitFailure({ limitKey, result, access }), requiredPlans: await plansGrantingLimit(limitKey, result) };
  const message = `Your ${details.currentPlan} plan allows up to ${details.limit} — upgrade to add more.`;

  if (mode === 'on') {
    recordEnforcementEvent(req, { action: 'billing.limit.blocked', metadata: details });
    if (throwOnBlock) throw new ApiError(402, message, details);
    return { ...result, allowed: false, blocked: true, warning: null, details, message };
  }

  recordEnforcementEvent(req, { action: 'billing.limit.warned', metadata: details });
  return { ...result, allowed: true, blocked: false, warning: attachBillingWarning(req, res, { ...details, message }) };
};

// Plans whose ceiling for this limit is higher than the current one — the upgrade list for a
// limit, computed the same way plansGrantingFeature computes it for a feature. Never a hardcoded
// "requires Pro" string, because the ceiling lives in an admin-editable plan row.
const plansGrantingLimit = async (limitKey, result) => {
  const plans = await Plan.find({ status: 'active', visibility: 'public' }).sort({ sortOrder: 1 });
  const current = isUnlimited(result.limit) ? Infinity : result.limit;

  return plans
    .filter((plan) => {
      const value = plan.limits?.get?.(limitKey) ?? plan.limits?.[limitKey];
      return value === UNLIMITED || value === undefined || value === null || Number(value) > current;
    })
    .map((plan) => ({
      planId: plan._id,
      planKey: plan.key,
      name: plan.name,
      prices: (plan.prices || [])
        .filter((price) => price.status === 'active')
        .map((price) => ({ interval: price.interval, amount: price.amount, currency: price.currency }))
    }));
};

/**
 * Route guard for a live-counted limit. `countFor(req)` returns the current occupancy.
 *
 * Deliberately not used for team seats: `teamLimitService.canInvite` already owns that count and
 * its callers already read it, so wiring this on top would be two answers to one question.
 */
export const requireLimit = (limitKey, countFor) => async (req, res, next) => {
  try {
    await checkLimitAllowed({ req, res, limitKey, used: await countFor(req) });
    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * "May this business own another workspace?" — the `businesses` ceiling plus the multi_business
 * feature, in one call. Exported for the create-business endpoint (Decision 6); nothing creates a
 * second business today, and a guard for an endpoint that does not exist would be a guess.
 */
export const assertBusinessCreationAllowed = async ({ req, res = null, ownedCount }) => {
  await checkFeatureAccess({ req, res, featureKey: 'multi_business' });
  return checkLimitAllowed({ req, res, limitKey: LIMITS.businesses, used: ownedCount });
};

// ---------------------------------------------------------------------------
// Metered quota — documents, exports, imports
// ---------------------------------------------------------------------------

/**
 * Consumes one unit of a metered limit, atomically (usageService does the check and the
 * increment in a single guarded update, so two concurrent creates cannot both pass at 199/200).
 *
 * `offline: true` is the mandatory offline rule (approved Decision 3): a document created offline
 * is already printed, numbered and in a customer's hands. It is counted, flagged as overage and
 * warned about — never refused, in any mode. Rejecting it would corrupt the number series and
 * destroy trust in the app for a billing reason.
 */
export const consumeQuota = async ({ req, res = null, limitKey, amount = 1, offline = false }) => {
  const mode = enforcementMode();
  const access = await req.access();
  const shared = { business: req.business._id, entitlements: access.entitlements, limitKey, amount };

  // Never-block modes still count, so the meters and the warn-mode analytics are honest.
  const allowOverage = offline || mode !== 'on';
  const ceiling = getLimit(access.entitlements, limitKey);

  // A ceiling of zero is already reached before anything is counted, and it cannot go through the
  // engine's guarded increment: with no counter row yet, `count: {$lte: -1}` matches nothing, the
  // upsert inserts, and the first unit of a zero-allowance plan would be let through. Handled
  // here rather than in the engine so the engine's atomic path stays exactly as it shipped.
  const atZeroCeiling = !isUnlimited(ceiling) && ceiling <= 0;
  const result = atZeroCeiling
    ? allowOverage
      ? await recordOverage({
          business: req.business._id,
          limitKey,
          amount,
          limit: ceiling,
          // Same bucket the engine would have used, or a lapsed business's overage lands in the paid month.
          fallback: usesFallbackQuota(access.entitlements)
        })
      : { allowed: false, limit: ceiling, used: 0, overage: 0, limitKey }
    : await incrementUsage({ ...shared, allowOverage });

  if (!result.allowed) {
    const details = {
      code: 'LIMIT_REACHED',
      metric: limitKey,
      limit: isUnlimited(result.limit) ? null : result.limit,
      used: result.used,
      currentPlan: access.planKey,
      subscriptionStatus: access.status,
      requiredPlans: await plansGrantingLimit(limitKey, result)
    };
    recordEnforcementEvent(req, { action: 'billing.limit.blocked', metadata: details });
    throw new ApiError(402, `You have used all ${details.limit} of your plan's ${limitKey.replace(/_/g, ' ')}.`, details);
  }

  // `off` counts but says nothing: the meters stay honest for the rollout decision while the
  // response shape stays byte-for-byte what it is today.
  if (result.overLimit && mode !== 'off') {
    const details = {
      code: offline ? 'LIMIT_EXCEEDED_OFFLINE' : 'LIMIT_EXCEEDED',
      metric: limitKey,
      limit: isUnlimited(result.limit) ? null : result.limit,
      used: result.used,
      overage: result.overage,
      currentPlan: access.planKey,
      subscriptionStatus: access.status,
      requiredPlans: await plansGrantingLimit(limitKey, result)
    };
    recordEnforcementEvent(req, {
      action: offline ? 'billing.limit.overage_offline' : 'billing.limit.overage',
      metadata: details
    });
    attachBillingWarning(req, res, { ...details, message: 'This is over your plan limit. Upgrade to keep going.' });
  }

  return result;
};

/** Gives a consumed unit back when the operation it was consumed for did not happen. */
export const releaseQuota = async ({ req, limitKey, amount = 1 }) => {
  const access = await req.access();
  // Releases into the bucket consumeQuota took it from — the resolved entitlements decide both.
  return decrementUsage({
    business: req.business._id,
    limitKey,
    amount,
    fallback: usesFallbackQuota(access.entitlements)
  }).catch(() => null);
};

/**
 * Runs `work` against a metered quota: consumed before, released if the work fails.
 *
 * That order matters — checking first and incrementing after would let a business at 199/200
 * create two documents concurrently, which is exactly the race usageService's atomic update
 * exists to prevent.
 */
export const meterQuota = async (req, limitKey, work, { res = null, offline = false } = {}) => {
  await consumeQuota({ req, res, limitKey, offline });

  try {
    return await work();
  } catch (error) {
    await releaseQuota({ req, limitKey });
    throw error;
  }
};

/**
 * Every path that issues a numbered sales document (invoice, duplicate, quotation, challan,
 * credit note, order conversion, offline push) goes through here, which is what makes the monthly
 * ceiling un-bypassable by adding a new caller.
 */
export const meterDocument = (req, create, options = {}) =>
  meterQuota(req, LIMITS.documentsPerMonth, create, options);
