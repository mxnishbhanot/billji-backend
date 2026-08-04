import Business from '../../models/Business.js';
import BusinessMember from '../../models/BusinessMember.js';
import Customer from '../../models/Customer.js';
import Plan from '../../models/Plan.js';
import Product from '../../models/Product.js';
import Vendor from '../../models/Vendor.js';
import { LIMITS } from '../../constants/entitlements.js';
import { subscriptionDto } from '../../contracts/billingDto.js';
import { getLimit, isUnlimited } from '../../services/entitlementService.js';
import { resolveAccess } from '../../services/subscriptionService.js';
import { usageSummary } from '../../services/usageService.js';

// Read-only billing queries. No mutation, no provider, no enforcement — this phase only lets
// the app SEE its plan. Checkout lands in Phase 3, guards in Phase 4.

/**
 * Live counters for the limits the usage engine deliberately does not meter (see
 * LIMIT_DEFINITIONS.metered). Counted against the real collections, so they cannot drift.
 *
 * Only limits with a finite ceiling are counted. On every current plan products/customers/vendors
 * are unlimited, so counting them would be four queries to produce a number nothing can act on.
 * A plan that later caps them starts being counted automatically — no code change.
 */
const COUNTERS = {
  [LIMITS.teamMembers]: ({ business }) => BusinessMember.countDocuments({ business: business._id, status: 'active' }),
  // Scoped to the owner, not the business: this limit governs how many businesses one owner may
  // run, which is what POST /businesses will check.
  [LIMITS.businesses]: ({ user }) => Business.countDocuments({ owner: user._id, status: 'active' }),
  [LIMITS.products]: ({ business }) => Product.countDocuments({ business: business._id }),
  [LIMITS.customers]: ({ business }) => Customer.countDocuments({ business: business._id }),
  [LIMITS.vendors]: ({ business }) => Vendor.countDocuments({ business: business._id })
};

export const liveCounts = async ({ entitlements, user, business }) => {
  const finite = Object.entries(COUNTERS).filter(([limitKey]) => !isUnlimited(getLimit(entitlements, limitKey)));
  const counted = await Promise.all(finite.map(([, count]) => count({ user, business })));
  return Object.fromEntries(finite.map(([limitKey], index) => [limitKey, counted[index]]));
};

/**
 * The single source of the subscription payload. Every endpoint that reports the current
 * subscription — GET /billing/subscription, GET /billing/usage, and the `subscription` block on
 * auth responses — goes through here, so the shape can never diverge between them.
 */
export const currentSubscription = async ({ user, business, access = null, now = new Date() }) => {
  // Callers behind `protect` pass req.access() so the whole request shares one resolve.
  const resolved = access || (await resolveAccess({ business, now }));
  const counts = await liveCounts({ entitlements: resolved.entitlements, user, business });
  const [usage, plan] = await Promise.all([
    usageSummary({ business: business._id, entitlements: resolved.entitlements, liveCounts: counts, at: now }),
    resolved.planId ? Plan.findById(resolved.planId).select('name key') : null
  ]);

  return subscriptionDto({ access: resolved, usage, plan });
};

/** The pricing screen. Private plans (enterprise, grandfathering) are never listed. */
export const listPlans = async ({ business, access = null }) => {
  const [plans, resolved] = await Promise.all([
    Plan.find({ status: 'active', visibility: 'public' }).sort({ sortOrder: 1 }),
    access || resolveAccess({ business })
  ]);

  return { plans, currentPlanId: resolved.planId };
};
