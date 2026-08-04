import { asyncHandler } from '../../utils/asyncHandler.js';
import { getPagination } from '../../utils/pagination.js';
import { currentSubscription } from '../billing/service.js';
import * as referralService from './service.js';

// Thin by design: parse, call the service, shape the response. No rules live here.

/** The user's own code plus their stats — one call, because the referral screen needs both. */
export const getMyReferral = asyncHandler(async (req, res) => {
  const summary = await referralService.referralSummary(req.user);
  res.json({ success: true, ...summary });
});

export const getMyStats = asyncHandler(async (req, res) => {
  const { stats } = await referralService.referralSummary(req.user);
  res.json({ success: true, stats });
});

export const getMyRewards = asyncHandler(async (req, res) => {
  const { limit, skip, page } = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 });
  const rewards = await referralService.rewardHistory({ user: req.user, limit, skip });
  res.json({ success: true, rewards, page, limit });
});

export const getMyReferrals = asyncHandler(async (req, res) => {
  const { limit, skip, page } = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 });
  const referrals = await referralService.myReferrals({ user: req.user, limit, skip });
  res.json({ success: true, referrals, page, limit });
});

/**
 * Can this user still apply a code? Needed so the app shows the "Have a referral code?" entry only to
 * someone it will work for — there is no time window, so the client cannot work this out itself.
 */
export const getEligibility = asyncHandler(async (req, res) => {
  const [{ eligible, reason }, code] = await Promise.all([
    referralService.checkEligibility(req.user),
    referralService.ensureReferralCode(req.user)
  ]);
  res.json({ success: true, eligible, reason, code });
});

/** Public: shape + existence, nothing about the user behind the code beyond a display name. */
export const validateReferralCode = asyncHandler(async (req, res) => {
  const result = await referralService.validateCode(req.body.code);
  res.json({
    success: true,
    valid: result.valid,
    code: result.code,
    referrerName: result.valid ? result.referrerName : undefined,
    reason: result.valid ? undefined : result.reason
  });
});

/**
 * Applies a code to the caller's account.
 *
 * TWO callers, deliberately one implementation: the online route below, and the offline sync push
 * (`referral:create` in modules/sync/registry.js), which routes here through the same validator chain,
 * permission and idempotency middleware as every other pushed operation.
 *
 * `clientId` arrives on the push path and makes a retried operation echo-match the referral it already
 * created instead of being rejected as a duplicate.
 */
export const applyReferral = asyncHandler(async (req, res) => {
  const { referral, reward, duplicate } = await referralService.applyReferral({
    user: req.user,
    business: req.business,
    code: req.body.code,
    clientId: req.body.clientId || null,
    req
  });

  res.status(duplicate ? 200 : 201).json({
    success: true,
    duplicate: Boolean(duplicate),
    referral: {
      id: referral._id,
      code: referral.code,
      status: referral.status,
      appliedAt: referral.createdAt,
      clientId: referral.clientId || null,
      version: referral.version ?? null,
      updatedAt: referral.updatedAt
    },
    reward: reward ? { id: reward._id, days: reward.grant?.days || 0, planKey: reward.grant?.planKey || '' } : null,
    // The fresh subscription, in the same DTO as GET /billing/subscription, so an online caller sees
    // Pro without a second request. The offline path ignores it and refreshes on its next pull.
    subscription: await currentSubscription({ user: req.user, business: req.business })
  });
});
