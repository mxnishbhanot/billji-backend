import BusinessInvitation from '../models/BusinessInvitation.js';
import BusinessMember from '../models/BusinessMember.js';
import { LIMITS } from '../constants/entitlements.js';
import { getLimit, isUnlimited } from './entitlementService.js';
import { resolveAccess } from './subscriptionService.js';
import { checkLimit } from './usageService.js';

// Team-size limit. Controllers call canInvite() and never see where the number comes from.
//
// Occupancy = seats taken: active members + still-pending invitations (a new invitee has no
// member row yet, so the pending invitation is what reserves their seat).

// Pre-billing fallback. A business with no Subscription row predates the billing engine, and
// shrinking what it is allowed would be exactly the silent downgrade Decision 2 forbids — so it
// keeps the caps it has always had until the P7 backfill gives it a subscription. New signups get
// a subscription immediately and go through the limit engine below.
const LEGACY_PLAN_LIMITS = { free: 2, pro: 5, business: 15, enterprise: Infinity };

export const getMemberLimit = (business) =>
  business?.plan?.maxMembers ?? LEGACY_PLAN_LIMITS[business?.plan?.key] ?? LEGACY_PLAN_LIMITS.free;

export const getCurrentMemberCount = async (business) => {
  const [members, invites] = await Promise.all([
    BusinessMember.countDocuments({ business: business._id, status: 'active' }),
    BusinessInvitation.countDocuments({ business: business._id, status: 'pending' })
  ]);
  return members + invites;
};

/**
 * Seats are a live-counted limit (LIMIT_DEFINITIONS.metered === false): the number is queried from
 * the real collections every time, so it cannot drift the way a stored counter could.
 */
export const canInvite = async (business) => {
  const [access, count] = await Promise.all([resolveAccess({ business }), getCurrentMemberCount(business)]);

  if (access.status === 'none') {
    const limit = getMemberLimit(business);
    return { allowed: count < limit, limit, count };
  }

  const result = await checkLimit({
    business: business._id,
    entitlements: access.entitlements,
    limitKey: LIMITS.teamMembers,
    used: count
  });

  return {
    allowed: result.allowed,
    // Infinity, not the -1 sentinel: callers compare this numerically and format it for humans.
    limit: isUnlimited(getLimit(access.entitlements, LIMITS.teamMembers)) ? Infinity : result.limit,
    count
  };
};
