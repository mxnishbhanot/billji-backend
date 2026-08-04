import mongoose from 'mongoose';

// Every reward BillJi has ever handed out, whatever granted it.
//
// Two jobs in one collection:
//
// 1. **The ledger.** A reward is money BillJi gave away. "Why does this business have Pro until
//    March when they never paid?" must be answerable years later, and SubscriptionHistory alone
//    cannot answer it — it records that a plan was applied, not which rule decided to.
//
// 2. **The idempotency lock.** The unique index on (rule, dedupeKey) is inserted BEFORE the reward
//    is applied, so a retried sync op, a redelivered webhook and a reconciliation replay all lose
//    the race to write the second row and grant nothing. Checking "did we already grant this?" in
//    application code would be a race; a unique index is not.

export const REWARD_STATUSES = ['granted', 'reversed'];

// What a reward physically does. Only plan_time is implemented — the rest are named so a future
// rule has an obvious home, not because anything reads them.
export const REWARD_TYPES = ['plan_time', 'wallet_credit', 'coupon', 'cashback', 'loyalty_points'];

const rewardGrantSchema = new mongoose.Schema(
  {
    // Which reward rule granted this (rewardRules/*.js). A string, not a ref: rules are code.
    rule: { type: String, required: true, trim: true, maxlength: 60, index: true },
    type: { type: String, enum: REWARD_TYPES, default: 'plan_time' },
    /**
     * The caller-supplied uniqueness key for this grant, scoped to the rule.
     *
     * The referral rules use the referral id, so one referred user can produce exactly one signup
     * reward and one conversion reward, for ever. The coupon rule uses the payment id. A rule that
     * is genuinely repeatable (a monthly loyalty drop) puts the period in its key.
     */
    dedupeKey: { type: String, required: true, trim: true, maxlength: 160 },

    // Who earned it and which workspace received it. A user earns; a business holds the plan.
    beneficiary: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    // Grouping for seasonal/promotional reporting. No campaign collection exists yet.
    campaign: { type: String, default: 'default', trim: true, lowercase: true, maxlength: 40, index: true },

    // What was given. planKey/days for plan_time; amount for a future credit/cashback rule.
    grant: {
      planKey: { type: String, default: '', trim: true, lowercase: true, maxlength: 60 },
      days: { type: Number, default: 0, min: 0 },
      amount: { type: Number, default: 0, min: 0 },
      currency: { type: String, default: 'INR', uppercase: true, trim: true, maxlength: 3 }
    },

    // Where the reward came from, for support: the referral, the payment, whatever the rule names.
    source: {
      referral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', default: null },
      payment: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPayment', default: null },
      note: { type: String, default: '', trim: true, maxlength: 300 }
    },

    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null },
    /**
     * The period end this grant produced.
     *
     * Written after the effect is applied, and it is what makes a grant reversible: a refund
     * subtracts the days it added, and `appliedAt == null` marks a grant whose lock was written but
     * whose effect never landed (a crash between the two) so the reconciliation job can finish it.
     */
    appliedPeriodEnd: { type: Date, default: null },
    appliedAt: { type: Date, default: null },

    status: { type: String, enum: REWARD_STATUSES, default: 'granted', index: true },
    reversedAt: { type: Date, default: null },
    reason: { type: String, default: '', trim: true, maxlength: 300 }
  },
  { timestamps: true }
);

// THE lock. Nothing else prevents a duplicate free month.
rewardGrantSchema.index({ rule: 1, dedupeKey: 1 }, { unique: true });
// "My rewards, newest first" for the customer-facing history.
rewardGrantSchema.index({ beneficiary: 1, createdAt: -1 });
// The reconciliation job: grants whose lock exists but whose effect never applied.
rewardGrantSchema.index({ status: 1, appliedAt: 1 });

const RewardGrant = mongoose.model('RewardGrant', rewardGrantSchema);

export default RewardGrant;
