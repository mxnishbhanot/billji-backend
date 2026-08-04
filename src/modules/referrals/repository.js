import BusinessMember from '../../models/BusinessMember.js';
import Referral from '../../models/Referral.js';
import SubscriptionPayment from '../../models/SubscriptionPayment.js';
import User from '../../models/User.js';

// Every database call the referral service makes. The service holds the rules, this holds the
// queries — same split as modules/payments.

export const findUserByReferralCode = (code) => User.findOne({ referralCode: code });

export const setReferralCode = (userId, code) =>
  User.updateOne({ _id: userId, referralCode: { $in: [null, undefined] } }, { $set: { referralCode: code } });

/** Written in the same call that creates the Referral, and never cleared. */
export const markReferredBy = (userId, referrerId) =>
  User.updateOne({ _id: userId, referredBy: null }, { $set: { referredBy: referrerId } });

export const findReferralForUser = (userId) => Referral.findOne({ referredUser: userId });

export const referralExistsForUser = (userId) => Referral.exists({ referredUser: userId });

export const createReferral = (payload) => Referral.create(payload);

export const findReferralByClientId = (businessId, clientId) => Referral.findOne({ business: businessId, clientId });

/**
 * Claims the pending -> converted transition atomically. Whichever caller wins writes the qualifying
 * payment; every later one (a webhook redelivery, a renewal, the reconciliation job) matches nothing
 * and grants nothing.
 */
export const claimConversion = ({ referralId, paymentId, now }) =>
  Referral.findOneAndUpdate(
    { _id: referralId, status: 'pending' },
    { $set: { status: 'converted', convertedAt: now, qualifyingPayment: paymentId } },
    { new: true }
  );

export const findReferralByQualifyingPayment = (paymentId) => Referral.findOne({ qualifyingPayment: paymentId });

export const releaseConversion = (referralId) =>
  Referral.updateOne(
    { _id: referralId },
    { $set: { status: 'pending', convertedAt: null, qualifyingPayment: null } }
  );

export const voidReferral = (referralId, reason) =>
  Referral.findOneAndUpdate(
    { _id: referralId, status: { $ne: 'void' } },
    { $set: { status: 'void', voidReason: String(reason).slice(0, 300) } },
    { new: true }
  );

export const listReferralsBy = ({ referrer, limit = 50, skip = 0 }) =>
  Referral.find({ referrer })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('referredUser', 'name email');

export const countReferralsBy = ({ referrer, status = null }) =>
  Referral.countDocuments({ referrer, ...(status ? { status } : {}) });

/** Every workspace this user is an active member of. */
export const businessIdsForUser = async (userId) => {
  const memberships = await BusinessMember.find({ user: userId, status: 'active' }).select('business').lean();
  return memberships.map((membership) => membership.business);
};

/**
 * Has this user ever paid BillJi for anything?
 *
 * `refunded` and `partially_refunded` count. A refund must not restore referral eligibility, or
 * buy-then-refund-then-apply is a free month on demand.
 */
export const hasPaidPurchase = async (userId) => {
  const businessIds = await businessIdsForUser(userId);
  if (!businessIds.length) return false;

  return Boolean(
    await SubscriptionPayment.exists({
      business: { $in: businessIds },
      status: { $in: ['captured', 'partially_refunded', 'refunded'] },
      netAmount: { $gt: 0 }
    })
  );
};

/**
 * Signups from one IP inside a window. The abuse signal a single-account check cannot see: twelve
 * accounts from one phone in one evening, each claiming a free month off the last.
 */
export const countRecentSignupsFromIp = (ip, since) =>
  ip ? Referral.countDocuments({ 'signup.ip': ip, createdAt: { $gte: since } }) : Promise.resolve(0);
