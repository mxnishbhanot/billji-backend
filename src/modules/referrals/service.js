import crypto from 'node:crypto';
import Business from '../../models/Business.js';
import Plan from '../../models/Plan.js';
import Referral from '../../models/Referral.js';
import ReferralReward from '../../models/ReferralReward.js';
import SubscriptionPayment from '../../models/SubscriptionPayment.js';
import { ApiError } from '../../utils/ApiError.js';
import { logAudit } from '../../services/auditService.js';
import { applyPlan, getSubscription, syncBusinessMirror } from '../../services/subscriptionService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The programme, in three numbers.
 *
 * A referred business gets a month of Pro for joining on a code. If it then actually pays, the
 * referrer gets a month added to whatever plan they are already on. The referrer's reward is
 * deliberately paid on conversion, not on signup: rewarding the signup alone pays for creating
 * empty accounts, which is the failure mode every referral programme dies of.
 */
export const REFEREE_FREE_DAYS = 30;
export const REFERRER_FREE_DAYS = 30;
// What the referred business's free month is worth, and the fallback for a referrer with nothing
// to extend. Never Starter — a free month of the free plan is not a reward.
export const REFERRAL_PLAN_KEY = 'pro';

// No 0/O/1/I/L: a referral code gets read off a phone screen and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

const randomCode = () =>
  Array.from(crypto.randomBytes(CODE_LENGTH))
    .map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length])
    .join('');

/**
 * This business's own code, minted on first use.
 *
 * Concurrency is handled by the unique index, not by a check-then-write: two devices opening the
 * referral screen at the same moment both draw a code, one insert loses, and the loser re-reads the
 * winner's code instead of overwriting it.
 */
export const ensureReferralCode = async (business) => {
  const businessId = business?._id || business;
  const current = await Business.findById(businessId).select('referralCode').lean();
  if (current?.referralCode) return current.referralCode;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    try {
      const updated = await Business.findOneAndUpdate(
        { _id: businessId, $or: [{ referralCode: '' }, { referralCode: { $exists: false } }] },
        { $set: { referralCode: code } },
        { new: true }
      ).select('referralCode');
      // Null means the business already had a code by the time this landed — someone else won.
      if (updated?.referralCode) return updated.referralCode;
      const settled = await Business.findById(businessId).select('referralCode').lean();
      if (settled?.referralCode) return settled.referralCode;
    } catch (error) {
      if (error?.code === 11000) continue; // drew a code another business already holds
      throw error;
    }
  }
  throw new ApiError(500, 'Could not generate a referral code, please try again');
};

const normalizeCode = (code) => String(code || '').trim().toUpperCase();

/** Has this business ever paid us? The signal for "too late to be referred". */
const hasEverPaid = async (businessId) =>
  Boolean(await SubscriptionPayment.exists({ business: businessId, status: 'captured' }));

/**
 * Why this business may not apply a code, or null when it may.
 *
 * Shared by the eligibility read and the apply write so the screen and the server can never
 * disagree about who is allowed in. The codes are the contract the mobile client treats as
 * permanent rejections — a queued APPLY_REFERRAL that gets one of these is abandoned, not retried.
 */
export const referralBlockReason = async (businessId) => {
  if (await Referral.exists({ business: businessId })) return 'REFERRAL_ALREADY_APPLIED';
  if (await ReferralReward.exists({ business: businessId, rule: 'referral_signup' })) {
    return 'REFERRAL_REWARD_ALREADY_RECEIVED';
  }
  if (await hasEverPaid(businessId)) return 'REFERRAL_NOT_ELIGIBLE_PAID';
  return null;
};

export const eligibilityFor = async (business) => {
  const businessId = business?._id || business;
  const [reason, code] = await Promise.all([referralBlockReason(businessId), ensureReferralCode(businessId)]);
  return { eligible: reason === null, reason, code };
};

/**
 * Resolves a typed code to the business that owns it, refusing the two codes that are never valid:
 * one nobody holds, and the caller's own.
 */
export const resolveCode = async ({ code, businessId }) => {
  const normalized = normalizeCode(code);
  if (!normalized) throw new ApiError(409, 'Enter a referral code', { code: 'REFERRAL_CODE_INVALID' });

  const referrer = await Business.findOne({ referralCode: normalized }).select('_id businessName').lean();
  if (!referrer) throw new ApiError(409, 'That referral code is not valid', { code: 'REFERRAL_CODE_INVALID' });
  if (String(referrer._id) === String(businessId)) {
    throw new ApiError(409, 'You cannot use your own referral code', { code: 'REFERRAL_SELF' });
  }
  return { referrer, code: normalized };
};

/** Read-only check for the pre-signup screen. Never says who owns the code beyond their name. */
export const validateCode = async (code) => {
  const normalized = normalizeCode(code);
  const referrer = normalized
    ? await Business.findOne({ referralCode: normalized }).select('businessName').lean()
    : null;
  return referrer
    ? { valid: true, code: normalized, referrerName: referrer.businessName }
    : { valid: false, code: normalized, reason: 'REFERRAL_CODE_INVALID' };
};

const planFor = async (key) => Plan.findOne({ key });

/**
 * Adds free days to a subscription.
 *
 * Two shapes, and the difference matters: a business with a running paid period gets those days
 * added to the end of it, keeping the plan it already has. A business on the free plan has no
 * period to extend (currentPeriodEnd is null = never expires), so instead it is put on the
 * referral plan for exactly that many days. Without the second branch a Starter referrer would be
 * told they won a free month and receive nothing.
 */
const grantFreeDays = async ({ businessId, days, rule, referral, now = new Date() }) => {
  const subscription = await getSubscription(businessId);
  const running = subscription?.currentPeriodEnd && subscription.currentPeriodEnd > now;

  if (running) {
    const extendMs = days * DAY_MS;
    subscription.currentPeriodEnd = new Date(subscription.currentPeriodEnd.getTime() + extendMs);
    subscription.graceEndsAt = subscription.graceEndsAt
      ? new Date(subscription.graceEndsAt.getTime() + extendMs)
      : subscription.currentPeriodEnd;
    subscription.status = 'active';
    await subscription.save();
    await syncBusinessMirror(subscription, 'active');
    return { subscription, planKey: subscription.planKey };
  }

  const plan = await planFor(REFERRAL_PLAN_KEY);
  if (!plan) throw new ApiError(500, 'Referral plan is missing. Run the billing seeder.', { code: 'REFERRAL_PLAN_MISSING' });

  const granted = await applyPlan({
    business: businessId,
    plan,
    interval: 'month',
    action: 'activated',
    actor: { type: 'system', note: 'referral' },
    now,
    // Free time, not a sale: the period is set explicitly and the price recorded is zero, so this
    // never looks like revenue and never locks a price in.
    amount: 0,
    periodEnd: new Date(now.getTime() + days * DAY_MS),
    metadata: { referralId: String(referral._id), rule }
  });
  return { subscription: granted, planKey: plan.key };
};

/**
 * Records one grant and applies it. The unique (referral, rule) index is the guard: a retried push
 * or a replayed webhook hits the duplicate and returns the existing row instead of buying a second
 * month. The row is written FIRST for that reason — claiming the slot before moving the date means
 * a crash in between costs a support call, not a repeatable exploit.
 */
const grantOnce = async ({ businessId, days, rule, referral, now = new Date() }) => {
  let reward;
  try {
    reward = await ReferralReward.create({
      business: businessId,
      referral: referral._id,
      rule,
      days,
      planKey: '',
      grantedAt: now
    });
  } catch (error) {
    if (error?.code === 11000) return { reward: await ReferralReward.findOne({ referral: referral._id, rule }), alreadyGranted: true };
    throw error;
  }

  const { subscription, planKey } = await grantFreeDays({ businessId, days, rule, referral, now });
  reward.planKey = planKey;
  reward.appliedPeriodEnd = subscription.currentPeriodEnd;
  await reward.save();

  return { reward, subscription, alreadyGranted: false };
};

/**
 * Applies a code to a business: the referral row, the referred business's free month, nothing else.
 * The referrer is paid later, by convertReferral, and only if this business pays.
 *
 * Idempotent on (business), which is what makes it safe on the offline path — the same operation
 * replayed from the outbox finds its own row and reports it rather than granting twice.
 */
export const applyReferral = async ({ business, code, clientId = null, now = new Date() }) => {
  const businessId = business?._id || business;

  const existing = await Referral.findOne({ business: businessId });
  if (existing) {
    if (clientId && existing.clientId === clientId) return { referral: existing, alreadyApplied: true };
    throw new ApiError(409, 'This account has already used a referral code', { code: 'REFERRAL_ALREADY_APPLIED' });
  }

  const blocked = await referralBlockReason(businessId);
  if (blocked) {
    throw new ApiError(409, blocked === 'REFERRAL_NOT_ELIGIBLE_PAID'
      ? 'Referral codes are for new accounts only'
      : 'This account has already received a referral reward', { code: blocked });
  }

  const { referrer, code: normalized } = await resolveCode({ code, businessId });

  let referral;
  try {
    referral = await Referral.create({
      business: businessId,
      referrerBusiness: referrer._id,
      code: normalized,
      status: 'pending',
      appliedAt: now,
      ...(clientId ? { clientId } : {})
    });
  } catch (error) {
    // Lost a race with another device pushing the same intent. The winner's row is the answer.
    if (error?.code === 11000) {
      const winner = await Referral.findOne({ business: businessId });
      if (winner) return { referral: winner, alreadyApplied: true };
    }
    throw error;
  }

  await grantOnce({ businessId, days: REFEREE_FREE_DAYS, rule: 'referral_signup', referral, now });

  void logAudit(null, {
    business: businessId,
    action: 'referral.applied',
    resourceType: 'referral',
    resourceId: String(referral._id),
    metadata: { code: normalized, referrerBusiness: String(referrer._id), days: REFEREE_FREE_DAYS }
  });

  return { referral, alreadyApplied: false };
};

/**
 * The referrer's half, triggered by the referred business's first captured payment.
 *
 * Called from the one place every capture funnels through, so it fires for a webhook, a client
 * verify and a reconciliation run alike. Never throws into the payment path: a referral reward that
 * fails to apply is a support ticket, whereas a payment that fails to activate because of one is a
 * paying customer locked out.
 */
export const convertReferral = async ({ business, now = new Date() }) => {
  const businessId = business?._id || business;
  const referral = await Referral.findOne({ business: businessId, status: 'pending' });
  if (!referral) return null;

  referral.status = 'converted';
  referral.convertedAt = now;
  await referral.save();

  const { reward } = await grantOnce({
    businessId: referral.referrerBusiness,
    days: REFERRER_FREE_DAYS,
    rule: 'referral_conversion',
    referral,
    now
  });

  void logAudit(null, {
    business: referral.referrerBusiness,
    action: 'referral.converted',
    resourceType: 'referral',
    resourceId: String(referral._id),
    metadata: { referredBusiness: String(businessId), days: REFERRER_FREE_DAYS }
  });

  return { referral, reward };
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const statsFor = async (businessId) => {
  const [referrals, rewards] = await Promise.all([
    Referral.find({ referrerBusiness: businessId }).select('status').lean(),
    ReferralReward.find({ business: businessId, status: 'granted' }).select('days').lean()
  ]);

  return {
    totalReferrals: referrals.length,
    pending: referrals.filter((row) => row.status === 'pending').length,
    converted: referrals.filter((row) => row.status === 'converted').length,
    rewardsEarned: rewards.length,
    freeDaysEarned: rewards.reduce((total, row) => total + (row.days || 0), 0)
  };
};

/**
 * A referrer is told that someone joined, not who: the referred business's name is its owner's
 * personal information, and nothing on the referral screen needs it.
 */
const maskName = (name) => {
  const trimmed = String(name || '').trim();
  if (!trimmed) return 'A new business';
  return `${trimmed.slice(0, 1).toUpperCase()}${'•'.repeat(Math.max(trimmed.length - 1, 2))}`;
};

export const referredUsersFor = async ({ businessId, page = 1, limit = 20 }) => {
  const rows = await Referral.find({ referrerBusiness: businessId })
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .populate('business', 'businessName')
    .lean();

  return rows.map((row) => ({
    id: String(row._id),
    name: maskName(row.business?.businessName),
    status: row.status,
    joinedAt: (row.appliedAt || row.createdAt).toISOString(),
    convertedAt: row.convertedAt ? row.convertedAt.toISOString() : null
  }));
};

export const rewardsFor = async ({ businessId, page = 1, limit = 20 }) => {
  const rows = await ReferralReward.find({ business: businessId })
    .sort({ grantedAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  return rows.map((row) => ({
    id: String(row._id),
    rule: row.rule,
    type: row.type,
    days: row.days,
    planKey: row.planKey,
    status: row.status,
    grantedAt: (row.grantedAt || row.createdAt).toISOString(),
    appliedPeriodEnd: row.appliedPeriodEnd ? row.appliedPeriodEnd.toISOString() : null,
    reversedAt: row.reversedAt ? row.reversedAt.toISOString() : null,
    ...(row.reason ? { reason: row.reason } : {})
  }));
};

export const serializeReferral = (referral) => ({
  // Both ids on purpose: the app's own type reads `id`, while the sync push executor stamps the
  // device's clientId onto `_id` and reports it back as the operation's serverId.
  _id: String(referral._id),
  id: String(referral._id),
  code: referral.code,
  status: referral.status,
  appliedAt: (referral.appliedAt || referral.createdAt).toISOString(),
  clientId: referral.clientId ?? null,
  version: referral.version ?? null,
  updatedAt: referral.updatedAt.toISOString()
});
