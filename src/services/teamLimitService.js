import BusinessInvitation from '../models/BusinessInvitation.js';
import BusinessMember from '../models/BusinessMember.js';

// Team-size limit abstraction. Reads business.plan (a per-business override maxMembers,
// else the plan key's cap); controllers call canInvite() and never see this mapping.
// Occupancy = seats taken: active members + still-pending invitations (a new invitee
// has no member row yet, so the pending invitation is what reserves their seat).
const PLAN_LIMITS = { free: 2, pro: 5, business: 15, enterprise: Infinity };

export const getMemberLimit = (business) =>
  business?.plan?.maxMembers ?? PLAN_LIMITS[business?.plan?.key] ?? PLAN_LIMITS.free;

export const getCurrentMemberCount = async (business) => {
  const [members, invites] = await Promise.all([
    BusinessMember.countDocuments({ business: business._id, status: 'active' }),
    BusinessInvitation.countDocuments({ business: business._id, status: 'pending' })
  ]);
  return members + invites;
};

export const canInvite = async (business) => {
  const [limit, count] = [getMemberLimit(business), await getCurrentMemberCount(business)];
  return { allowed: count < limit, limit, count };
};
