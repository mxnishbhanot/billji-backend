import Plan from '../models/Plan.js';
import RewardGrant from '../models/RewardGrant.js';
import Subscription from '../models/Subscription.js';
import { ApiError } from '../utils/ApiError.js';
import { logAudit } from './auditService.js';
import { upsertNotification } from './notificationService.js';
import { couponTime } from './rewardRules/couponTime.js';
import { referralConversion } from './rewardRules/referralConversion.js';
import { referralSignup } from './rewardRules/referralSignup.js';
import { applyPlan, getSubscription, isEntitled, syncBusinessMirror } from './subscriptionService.js';

// THE REWARD ENGINE.
//
// The only service in this backend allowed to hand out something the customer did not pay for.
// Referral, coupon free-time and every future reward (wallet credit, cashback, loyalty points,
// festival bonus) route through grant()/reverse(), so there is exactly one implementation, one
// ledger (RewardGrant) and one audit trail — instead of five services each quietly extending
// currentPeriodEnd in their own way.
//
// Deliberately small. A rule is a static object naming what the reward IS; the engine decides how to
// apply it. No rule builders, no JSON rules, no DSL, no plugin loader, no admin rule editor — those
// arrive if and when a real second reward type needs them, and nothing here blocks that.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every reward rule in the system. A new reward type adds a file and one line here. */
export const REWARD_RULES = {
  [referralSignup.key]: referralSignup,
  [referralConversion.key]: referralConversion,
  [couponTime.key]: couponTime
};

export const getRewardRule = (key) => REWARD_RULES[key] || null;

/** Tier order comes from the catalog's own sortOrder, so it follows an admin's plan edits. */
const planRank = (plan) => plan?.sortOrder ?? 0;

/**
 * Adds plan time.
 *
 * Two rules the whole reward feature depends on:
 *
 * 1. **Never shorten, never downgrade.** Time is added from `max(now, currentPeriodEnd)`, so a
 *    customer who already paid to March keeps March and gains 30 days on top. And if they are on a
 *    plan ABOVE the reward's plan, the reward extends what they have rather than applying Pro over
 *    Business — a "reward" that downgrades a paying customer is a bug with an apology attached.
 * 2. **Reward time is never charged.** amount: 0, and pricing is left unlocked so the next real
 *    renewal prices normally.
 */
const applyPlanTime = async ({ business, planKey, days, actor, metadata, now }) => {
  const plan = await Plan.findOne({ key: planKey });
  if (!plan) throw new ApiError(500, `Cannot grant a reward: plan ${planKey} does not exist`, { code: 'REWARD_PLAN_MISSING' });

  const existing = await getSubscription(business);
  const base = existing?.currentPeriodEnd && existing.currentPeriodEnd > now ? existing.currentPeriodEnd : now;
  const bonusMs = days * DAY_MS;

  const currentPlan = existing?.plan ? await Plan.findById(existing.plan) : null;
  const holdsHigherPlan = existing && isEntitled(existing, now) && planRank(currentPlan) > planRank(plan);

  if (holdsHigherPlan) {
    // Extend in place: same plan, same snapshot, more days. applyPlan would re-snapshot the reward's
    // (lower) plan over the one they are actually on.
    //
    // No SubscriptionHistory row on this branch — nothing about the plan or its snapshot changed, only
    // the end date. The grant is still fully traceable through RewardGrant (which records the days and
    // the resulting period end) and the reward.granted audit entry.
    const graceMs = existing.graceEndsAt && existing.currentPeriodEnd
      ? existing.graceEndsAt.getTime() - existing.currentPeriodEnd.getTime()
      : 0;
    existing.currentPeriodEnd = new Date(base.getTime() + bonusMs);
    existing.graceEndsAt = new Date(existing.currentPeriodEnd.getTime() + graceMs);
    await existing.save();
    await syncBusinessMirror(existing, 'active');
    return existing;
  }

  return applyPlan({
    business,
    plan,
    interval: 'month',
    action: 'reward_granted',
    actor,
    now,
    amount: 0,
    periodEnd: new Date(base.getTime() + bonusMs),
    metadata
  });
};

/**
 * Grants a reward. Idempotent by construction.
 *
 * The order is the point: the RewardGrant row (the lock) is inserted BEFORE anything is given away.
 * A duplicate key means some other caller — a retried sync push, a redelivered webhook, the
 * reconciliation job — already owns this grant, and this call returns without spending a second time.
 * Checking first and writing after would be a race, and the thing being raced is free months.
 *
 * @param rule       key in REWARD_RULES
 * @param dedupeKey  what makes this grant unique within the rule (a referral id, a payment id)
 * @param effect     overrides the rule's own effect; required for rules whose amount varies (coupons)
 */
export const grant = async ({
  rule,
  dedupeKey,
  beneficiary,
  business,
  effect: effectOverride = null,
  campaign = 'default',
  source = {},
  actor = { type: 'system' },
  notify = true,
  now = new Date()
}) => {
  const definition = getRewardRule(rule);
  if (!definition) throw new Error(`Unknown reward rule: ${rule}`);

  const effect = effectOverride || definition.effect;
  if (!effect) throw new Error(`Reward rule ${rule} needs an effect`);

  const beneficiaryId = beneficiary?._id || beneficiary;
  const businessId = business?._id || business;
  if (!beneficiaryId || !businessId) throw new Error(`Reward rule ${rule} needs a beneficiary and a business`);

  let record;
  try {
    record = await RewardGrant.create({
      rule,
      type: definition.type,
      dedupeKey: String(dedupeKey),
      beneficiary: beneficiaryId,
      business: businessId,
      campaign,
      grant: { planKey: effect.planKey || '', days: effect.days || 0, amount: effect.amount || 0 },
      source
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;

    const existing = await RewardGrant.findOne({ rule, dedupeKey: String(dedupeKey) });
    // A lock with no effect behind it is a crash between the two writes. Finish it rather than
    // reporting success on a reward nobody received — the same recovery applyCapturedPayment needed.
    if (existing && !existing.appliedAt && existing.status === 'granted') {
      record = existing;
    } else {
      return { grant: existing, alreadyGranted: true };
    }
  }

  const subscription = await applyPlanTime({
    business: businessId,
    planKey: effect.planKey,
    days: effect.days,
    actor,
    metadata: { source: 'reward', rule, rewardGrantId: String(record._id), campaign },
    now
  });

  record.subscription = subscription._id;
  record.appliedPeriodEnd = subscription.currentPeriodEnd;
  record.appliedAt = new Date();
  await record.save();

  void logAudit(null, {
    business: businessId,
    action: 'reward.granted',
    resourceType: 'rewardGrant',
    resourceId: record._id,
    metadata: { rule, dedupeKey: String(dedupeKey), days: effect.days, planKey: effect.planKey, beneficiary: String(beneficiaryId) }
  });

  if (notify) {
    void upsertNotification({
      business: businessId,
      notificationId: `reward:${record._id}`,
      type: 'reward-granted',
      resourceType: 'subscription',
      resourceId: subscription._id,
      tone: 'success',
      title: definition.title,
      description: definition.description,
      metadata: { rule, days: effect.days, planKey: effect.planKey }
    }).catch((error) => console.error('[rewards] notification failed:', error.message));
  }

  return { grant: record, subscription, alreadyGranted: false };
};

/**
 * Takes a granted reward back — a refunded purchase, a voided referral, support correcting a mistake.
 *
 * Subtracts exactly the days this grant added, floored at now: a reversal must never reach back into
 * a period the customer paid for with real money, and must never leave a period in the past pretending
 * to be the future.
 */
export const reverse = async ({ grant: record, reason = '', actor = { type: 'system' }, now = new Date() }) => {
  const claimed = await RewardGrant.findOneAndUpdate(
    { _id: record._id, status: 'granted' },
    { $set: { status: 'reversed', reversedAt: now, reason: String(reason).slice(0, 300) } },
    { new: true }
  );

  // Already reversed by the other path (admin before webhook, or a redelivery). Idempotent.
  if (!claimed) return { grant: await RewardGrant.findById(record._id), alreadyReversed: true };

  const days = claimed.grant?.days || 0;
  const subscription = claimed.subscription ? await Subscription.findById(claimed.subscription) : null;

  if (subscription && days > 0 && subscription.currentPeriodEnd) {
    const graceMs = subscription.graceEndsAt
      ? subscription.graceEndsAt.getTime() - subscription.currentPeriodEnd.getTime()
      : 0;
    const shortened = new Date(Math.max(now.getTime(), subscription.currentPeriodEnd.getTime() - days * DAY_MS));
    subscription.currentPeriodEnd = shortened;
    subscription.graceEndsAt = new Date(shortened.getTime() + graceMs);
    await subscription.save();
    await syncBusinessMirror(subscription, 'active');
  }

  void logAudit(null, {
    business: claimed.business,
    action: 'reward.reversed',
    resourceType: 'rewardGrant',
    resourceId: claimed._id,
    metadata: { rule: claimed.rule, days, reason: String(reason).slice(0, 300), actor: actor.type }
  });

  return { grant: claimed, subscription, alreadyReversed: false };
};

/** Rewards a user has received, newest first. Powers the customer-facing history and support. */
export const listGrantsFor = ({ beneficiary, rule = null, limit = 50, skip = 0 }) =>
  RewardGrant.find({ beneficiary: beneficiary?._id || beneficiary, ...(rule ? { rule } : {}) })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

export const countGrantsFor = ({ beneficiary, rule = null, status = null }) =>
  RewardGrant.countDocuments({
    beneficiary: beneficiary?._id || beneficiary,
    ...(rule ? { rule } : {}),
    ...(status ? { status } : {})
  });

export const hasGrant = ({ beneficiary, rule }) =>
  RewardGrant.exists({ beneficiary: beneficiary?._id || beneficiary, rule, status: 'granted' });

/**
 * Finishes grants whose lock was written but whose effect never landed (a crash, a restart, a
 * MongoDB blip between the two writes). Registered as a scheduled job for the same reason
 * billing:reconcile-activations exists: a customer promised a reward and given nothing is a state no
 * retry would ever repair on its own, because the lock makes every retry look like success.
 */
export const reconcileUnappliedGrants = async ({ limit = 50, now = new Date() } = {}) => {
  const stranded = await RewardGrant.find({ status: 'granted', appliedAt: null })
    .sort({ createdAt: 1 })
    .limit(limit);

  let repaired = 0;
  for (const record of stranded) {
    const definition = getRewardRule(record.rule);
    if (!definition) continue;

    try {
      const subscription = await applyPlanTime({
        business: record.business,
        planKey: record.grant.planKey,
        days: record.grant.days,
        actor: { type: 'system', note: 'reward reconciliation' },
        metadata: { source: 'reward', rule: record.rule, rewardGrantId: String(record._id), reconciled: true },
        now
      });
      record.subscription = subscription._id;
      record.appliedPeriodEnd = subscription.currentPeriodEnd;
      record.appliedAt = new Date();
      await record.save();
      repaired += 1;
    } catch (error) {
      console.error(`[rewards] could not finish grant ${record._id}:`, error.message);
    }
  }

  return { scanned: stranded.length, repaired };
};
