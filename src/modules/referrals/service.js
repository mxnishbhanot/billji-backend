import Business from '../../models/Business.js';
import User from '../../models/User.js';
import { logAudit } from '../../services/auditService.js';
import { countGrantsFor, grant, hasGrant, listGrantsFor, reverse } from '../../services/rewardEngine.js';
import { ApiError } from '../../utils/ApiError.js';
import { generateReferralCode, normalizeReferralCode } from '../../utils/referralCode.js';
import * as repository from './repository.js';

// REFERRAL RULES.
//
// This service decides WHETHER someone gets a reward. rewardEngine decides HOW to give it and owns
// the ledger — nothing here touches a Subscription directly.
//
// There is no time window on applying a code: eligibility is a state, not a deadline. A shopkeeper who
// signs up in January, hears about the referral scheme in April and has never paid is still eligible.
// What closes the door is having been referred already, having already had a signup reward, or having
// ever paid for a plan.

const DAY_MS = 24 * 60 * 60 * 1000;

// Referral applications from one IP per day beyond which the next one is refused with a 429 — a rate
// limit, not a verdict: nothing is written, so the user stays eligible and can try again tomorrow.
// Generous on purpose: a family shop, a shared hotspot and a college wifi are all one IP.
// Live-read from env, like syncProtocol.safetyLagMs: a test has to be able to prove both branches, and
// this is a safety valve support may want to widen without a deploy. 0 disables the check.
const maxSignupsPerIpPerDay = () => Number(process.env.REFERRAL_MAX_SIGNUPS_PER_IP_PER_DAY ?? 3);

export const REFERRAL_ERRORS = {
  invalidCode: 'REFERRAL_CODE_INVALID',
  self: 'REFERRAL_SELF',
  alreadyApplied: 'REFERRAL_ALREADY_APPLIED',
  alreadyRewarded: 'REFERRAL_REWARD_ALREADY_RECEIVED',
  notEligiblePaid: 'REFERRAL_NOT_ELIGIBLE_PAID',
  abuse: 'REFERRAL_LIMIT_REACHED'
};

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * The user's own code, minted on first read if they predate the feature.
 *
 * Lazy generation rather than a migration-only backfill: the backfill script exists, but a user who
 * logs in before it runs must still see a code, and this is idempotent either way. Retries on the
 * unique-index collision, exactly like createResetCode.
 */
export const ensureReferralCode = async (user) => {
  if (user.referralCode) return user.referralCode;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateReferralCode();
    try {
      const result = await repository.setReferralCode(user._id, code);
      // Another request minted one first; read it back rather than overwriting a live code.
      if (result.modifiedCount === 0) {
        const fresh = await User.findById(user._id).select('referralCode');
        if (fresh?.referralCode) {
          user.referralCode = fresh.referralCode;
          return fresh.referralCode;
        }
        continue;
      }
      user.referralCode = code;
      return code;
    } catch (error) {
      if (error?.code === 11000) continue; // code collision — draw another
      throw error;
    }
  }

  throw new ApiError(500, 'Could not generate a referral code, please try again');
};

/** Code shape + existence only. Never eligibility: that needs to know who is asking. */
export const validateCode = async (rawCode, { requestingUser = null } = {}) => {
  const code = normalizeReferralCode(rawCode);
  const referrer = await repository.findUserByReferralCode(code);

  if (!referrer) return { valid: false, code, reason: REFERRAL_ERRORS.invalidCode };
  if (requestingUser && String(referrer._id) === String(requestingUser._id)) {
    return { valid: false, code, reason: REFERRAL_ERRORS.self };
  }

  return { valid: true, code, referrer, referrerName: referrer.name };
};

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Can this user still be referred by someone?
 *
 * Ordered cheapest-first: the two field checks answer the common case off the user document the auth
 * middleware already loaded, before any query runs.
 */
export const checkEligibility = async (user) => {
  if (user.referredBy) return { eligible: false, reason: REFERRAL_ERRORS.alreadyApplied };
  if (await repository.referralExistsForUser(user._id)) return { eligible: false, reason: REFERRAL_ERRORS.alreadyApplied };
  if (await hasGrant({ beneficiary: user._id, rule: 'referral_signup' })) {
    return { eligible: false, reason: REFERRAL_ERRORS.alreadyRewarded };
  }
  if (await repository.hasPaidPurchase(user._id)) return { eligible: false, reason: REFERRAL_ERRORS.notEligiblePaid };

  return { eligible: true, reason: null };
};

const ELIGIBILITY_ERRORS = {
  [REFERRAL_ERRORS.alreadyApplied]: [409, 'You have already used a referral code'],
  [REFERRAL_ERRORS.alreadyRewarded]: [409, 'You have already received a referral reward'],
  [REFERRAL_ERRORS.notEligiblePaid]: [409, 'Referral codes can only be used before your first paid subscription']
};

export const assertEligible = async (user) => {
  const { eligible, reason } = await checkEligibility(user);
  if (eligible) return;

  const [status, message] = ELIGIBILITY_ERRORS[reason] || [409, 'You are not eligible for a referral reward'];
  throw new ApiError(status, message, { code: reason });
};

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

const signupFingerprint = (req) => ({
  ip: req?.ip || req?.headers?.['x-forwarded-for']?.split(',')?.[0]?.trim() || '',
  deviceName: (req?.get?.('x-device-name') || '').trim().slice(0, 120),
  userAgent: (req?.get?.('user-agent') || '').slice(0, 300)
});

/**
 * Applies a referral code to a user, and grants them their free month.
 *
 * Every entry point lands here: the register body, the online POST /referrals/apply, and the offline
 * `referral:create` sync push. One implementation, so the three cannot disagree about the rules.
 *
 * Idempotent three ways over: `clientId` echo-matching for a replayed push, the unique index on
 * Referral.referredUser for a racing second writer, and the reward engine's own (rule, dedupeKey)
 * lock for the free month itself.
 */
export const applyReferral = async ({ user, business, code: rawCode, clientId = null, req = null, now = new Date() }) => {
  const businessId = business?._id || business;

  // A retried offline push: return the referral this device already created rather than rejecting it
  // as "already applied". Same echo-match the sync push path does for every other entity.
  if (clientId) {
    const echoed = await repository.findReferralByClientId(businessId, clientId);
    if (echoed) return { referral: echoed, duplicate: true };
  }

  const { valid, code, referrer, reason } = await validateCode(rawCode, { requestingUser: user });
  if (!valid) {
    if (reason === REFERRAL_ERRORS.self) {
      throw new ApiError(403, 'You cannot use your own referral code', { code: REFERRAL_ERRORS.self });
    }
    throw new ApiError(422, 'That referral code is not valid', { code: REFERRAL_ERRORS.invalidCode });
  }

  // A second account on the same email is the same person. Compared as well as the id because a
  // deleted-and-recreated referrer would otherwise pass the id check.
  if (referrer.email && user.email && referrer.email.toLowerCase() === String(user.email).toLowerCase()) {
    throw new ApiError(403, 'You cannot use your own referral code', { code: REFERRAL_ERRORS.self });
  }

  await assertEligible(user);

  const signup = signupFingerprint(req);
  const recentFromIp = await repository.countRecentSignupsFromIp(signup.ip, new Date(now.getTime() - DAY_MS));

  const ipLimit = maxSignupsPerIpPerDay();
  if (ipLimit > 0 && recentFromIp >= ipLimit) {
    // Refused BEFORE anything is written, so this stays a rate limit and never becomes a verdict: a
    // family shop, a shared hotspot and a market wifi are all one IP, and burning their eligibility for
    // ever over a busy afternoon would punish the wrong people. They can try again tomorrow.
    void logAudit(req, {
      business: businessId,
      action: 'referral.rate_limited',
      resourceType: 'user',
      resourceId: user._id,
      metadata: { code, ip: signup.ip, recentFromIp }
    });
    throw new ApiError(429, 'Too many referral signups from this network. Please try again later.', {
      code: REFERRAL_ERRORS.abuse
    });
  }

  let referral;
  try {
    referral = await repository.createReferral({
      referrer: referrer._id,
      referredUser: user._id,
      business: businessId,
      code,
      signup,
      ...(clientId ? { clientId } : {})
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Lost the race to another writer (a push arriving as the register body was still processing).
    const existing = await repository.findReferralForUser(user._id);
    if (existing) return { referral: existing, duplicate: true };
    throw error;
  }

  // referredBy mirrors the edge onto the user document so eligibility is answerable without a query.
  // Never cleared, so "used a code once" is permanent even if the referral is later voided.
  await repository.markReferredBy(user._id, referrer._id);
  user.referredBy = referrer._id;

  void logAudit(req, {
    business: businessId,
    action: 'referral.applied',
    resourceType: 'referral',
    resourceId: referral._id,
    metadata: { code, referrer: String(referrer._id) }
  });

  const { grant: rewardGrant, subscription } = await grant({
    rule: 'referral_signup',
    dedupeKey: String(referral._id),
    beneficiary: user._id,
    business: businessId,
    campaign: referral.campaign,
    source: { referral: referral._id, note: `Signed up with ${code}` },
    actor: { type: 'system', note: 'referral signup' },
    now
  });

  return { referral, reward: rewardGrant, subscription, duplicate: false };
};

/**
 * Best-effort attach used by the signup paths.
 *
 * A referral code must never be able to fail a registration — the account and the business are
 * already created by the time this runs, and a 422 on a mistyped code would leave the caller
 * believing the whole signup failed. The reason travels back so the client can show it and, if it is
 * retryable, queue the offline op.
 */
export const attachReferralAtSignup = async ({ user, business, code, req, now = new Date() }) => {
  if (!code) return null;

  try {
    const result = await applyReferral({ user, business, code, req, now });
    return { applied: true, code: result.referral.code, reason: null };
  } catch (error) {
    const reason = error?.details?.code || 'REFERRAL_FAILED';
    console.error(`[referrals] could not apply ${code} at signup:`, error.message);
    return { applied: false, code: normalizeReferralCode(code), reason, message: error.message };
  }
};

// ---------------------------------------------------------------------------
// Conversion (the referrer's reward)
// ---------------------------------------------------------------------------

/**
 * Called from applyCapturedPayment for every captured payment — the one choke point every real
 * payment passes through (client verify, webhook, autopay cycle, reconciliation).
 *
 * Non-fatal by contract: the caller invokes this with `void ... .catch()`, because a reward that
 * cannot be granted must never fail the activation of a subscription somebody just paid for.
 */
export const onPaidSubscription = async ({ payment, now = new Date() }) => {
  // A ₹0 activation (a 100%-off coupon, a fully credited upgrade) is not a purchase.
  if (!payment || payment.netAmount <= 0) return { converted: false, reason: 'not_a_purchase' };

  const business = await Business.findById(payment.business).select('owner');
  if (!business?.owner) return { converted: false, reason: 'no_owner' };

  const referral = await repository.findReferralForUser(business.owner);
  // No referral, already converted, or voided for abuse: nothing to pay out.
  if (!referral || referral.status !== 'pending') return { converted: false, reason: 'no_pending_referral' };

  const claimed = await repository.claimConversion({ referralId: referral._id, paymentId: payment._id, now });
  if (!claimed) return { converted: false, reason: 'already_converted' };

  const referrer = await User.findById(claimed.referrer).select('defaultBusiness');
  if (!referrer?.defaultBusiness) {
    // Referrer deleted, or has no workspace to receive the plan. The conversion stands (it is a fact
    // about the referred user) and the grant is skipped; support can grant it by hand later.
    console.error(`[referrals] referral ${claimed._id} converted but referrer has no business to reward`);
    return { converted: true, rewarded: false, reason: 'referrer_unavailable' };
  }

  const { grant: rewardGrant, alreadyGranted } = await grant({
    rule: 'referral_conversion',
    // The referral id, not the payment id: one referred user can only ever produce one conversion
    // reward, so a second purchase (a renewal, an upgrade) cannot mint a second month.
    dedupeKey: String(claimed._id),
    beneficiary: claimed.referrer,
    business: referrer.defaultBusiness,
    campaign: claimed.campaign,
    source: { referral: claimed._id, payment: payment._id, note: 'First paid subscription by a referred user' },
    actor: { type: 'system', note: 'referral conversion' },
    now
  });

  void logAudit(null, {
    business: referrer.defaultBusiness,
    action: 'referral.converted',
    resourceType: 'referral',
    resourceId: claimed._id,
    metadata: { paymentId: String(payment._id), rewardGrantId: String(rewardGrant?._id || ''), alreadyGranted }
  });

  return { converted: true, rewarded: !alreadyGranted, referral: claimed, reward: rewardGrant };
};

/**
 * A refunded purchase takes the referrer's reward back and reopens the conversion.
 *
 * Reopened rather than voided: the referred user may buy again, and that purchase should pay the
 * referrer exactly as the refunded one was supposed to. The reward engine's lock still holds, so the
 * second purchase does not mint a second month — the reversed grant is the record of the first.
 */
export const reverseRewardForPayment = async ({ payment, actor = { type: 'system' }, now = new Date() }) => {
  const referral = await repository.findReferralByQualifyingPayment(payment._id);
  if (!referral) return { reversed: false, reason: 'no_referral_for_payment' };

  const grants = await listGrantsFor({ beneficiary: referral.referrer, rule: 'referral_conversion', limit: 20 });
  const target = grants.find((candidate) => String(candidate.dedupeKey) === String(referral._id) && candidate.status === 'granted');

  await repository.releaseConversion(referral._id);
  if (!target) return { reversed: false, reason: 'no_grant_to_reverse' };

  const { alreadyReversed } = await reverse({
    grant: target,
    reason: `Refunded payment ${payment._id}`,
    actor,
    now
  });

  return { reversed: !alreadyReversed, referral, grant: target };
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const referralSummary = async (user) => {
  const code = await ensureReferralCode(user);
  const [total, pending, converted, rewards] = await Promise.all([
    repository.countReferralsBy({ referrer: user._id }),
    repository.countReferralsBy({ referrer: user._id, status: 'pending' }),
    repository.countReferralsBy({ referrer: user._id, status: 'converted' }),
    countGrantsFor({ beneficiary: user._id, rule: 'referral_conversion', status: 'granted' })
  ]);

  return {
    code,
    stats: {
      totalReferrals: total,
      pending,
      converted,
      rewardsEarned: rewards,
      // Every conversion reward is 30 days; keep the arithmetic here rather than making the client
      // know the reward size.
      freeDaysEarned: rewards * 30
    }
  };
};

export const rewardHistory = async ({ user, limit, skip }) => {
  const grants = await listGrantsFor({ beneficiary: user._id, limit, skip });
  return grants.map((record) => ({
    id: record._id,
    rule: record.rule,
    type: record.type,
    days: record.grant?.days || 0,
    planKey: record.grant?.planKey || '',
    status: record.status,
    grantedAt: record.createdAt,
    appliedPeriodEnd: record.appliedPeriodEnd,
    reversedAt: record.reversedAt,
    reason: record.reason
  }));
};

// Names are masked: a referrer may see that someone joined, never their full identity.
const maskName = (name = '') => {
  const parts = String(name).trim().split(/\s+/);
  const first = parts[0] || 'BillJi user';
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0]}.` : first;
};

export const myReferrals = async ({ user, limit, skip }) => {
  const referrals = await repository.listReferralsBy({ referrer: user._id, limit, skip });
  return referrals.map((referral) => ({
    id: referral._id,
    name: maskName(referral.referredUser?.name),
    status: referral.status,
    joinedAt: referral.createdAt,
    convertedAt: referral.convertedAt
  }));
};

// ---------------------------------------------------------------------------
// Internal / future admin panel
// ---------------------------------------------------------------------------
//
// Service methods only — no routes, because there is no admin panel yet. They exist so wiring one up
// later (behind requirePlatformAdmin, P6) is a routes file and nothing else.

export const adminListReferrals = ({ referrerId, limit = 50, skip = 0 }) =>
  repository.listReferralsBy({ referrer: referrerId, limit, skip });

export const adminVoidReferral = async ({ referralId, reason = 'Voided by support', actor = { type: 'admin' } }) => {
  const referral = await repository.voidReferral(referralId, reason);
  if (!referral) throw new ApiError(404, 'Referral not found or already void');

  void logAudit(null, {
    business: referral.business,
    action: 'referral.voided',
    resourceType: 'referral',
    resourceId: referral._id,
    metadata: { reason, actor: actor.type }
  });

  return referral;
};

export const adminReverseReward = ({ grant: record, reason = 'Reversed by support', actor = { type: 'admin' } }) =>
  reverse({ grant: record, reason, actor });
