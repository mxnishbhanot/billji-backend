import { planDto } from '../../contracts/billingDto.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { currentSubscription, listPlans } from './service.js';

// req.access() (attached by protect) resolves the subscription once per request and memoizes it,
// so passing it through keeps a single resolve no matter how many things ask.

/**
 * The current subscription. One shape, defined in contracts/billingDto.js and shared with the
 * `subscription` block on every auth response, so mobile has a single thing to code against.
 */
export const getSubscription = asyncHandler(async (req, res) => {
  const subscription = await currentSubscription({ user: req.user, business: req.business, access: await req.access() });

  res.json({ success: true, subscription });
});

/**
 * Usage only. Same numbers as the subscription payload — this endpoint exists so a meter can be
 * refreshed without re-fetching the whole subscription, and it deliberately reuses the same DTO
 * fields rather than inventing a second usage shape.
 */
export const getUsage = asyncHandler(async (req, res) => {
  const subscription = await currentSubscription({ user: req.user, business: req.business, access: await req.access() });

  res.json({
    success: true,
    usage: {
      contractVersion: subscription.contractVersion,
      subscriptionStatus: subscription.subscriptionStatus,
      usageSummary: subscription.usageSummary,
      remainingLimits: subscription.remainingLimits
    }
  });
});

/** Public plan catalog for the pricing screen, with the caller's current plan marked. */
export const getPlans = asyncHandler(async (req, res) => {
  const { plans, currentPlanId } = await listPlans({ business: req.business, access: await req.access() });

  res.json({ success: true, plans: plans.map((plan) => planDto(plan, { currentPlanId })) });
});
