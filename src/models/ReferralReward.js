import mongoose from 'mongoose';

export const REFERRAL_RULES = ['referral_signup', 'referral_conversion'];

/**
 * The grant ledger: every free day this feature has ever handed out, to whom, and against which
 * period end it was applied.
 *
 * Subscriptions hold only the resulting date, so without this row there is no way to answer "why
 * does this business have three extra months" during a support call or a fraud review — and no way
 * to reverse one grant without guessing which days it bought.
 */
const referralRewardSchema = new mongoose.Schema(
  {
    // Who received the free time — the referred business for a signup grant, the referrer for a
    // conversion grant.
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    referral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', required: true, index: true },
    rule: { type: String, enum: REFERRAL_RULES, required: true },
    type: { type: String, default: 'free_days', trim: true, maxlength: 40 },
    days: { type: Number, required: true, min: 0 },
    // Which plan the free time was worth. For a conversion grant this is whatever plan the referrer
    // was already on — the reward extends what they hold, it never changes it.
    planKey: { type: String, default: '', trim: true, lowercase: true, maxlength: 60 },
    status: { type: String, enum: ['granted', 'reversed'], default: 'granted', index: true },
    grantedAt: { type: Date, default: () => new Date() },
    // The period end this grant produced, so a reversal knows exactly what to take back.
    appliedPeriodEnd: { type: Date, default: null },
    reversedAt: { type: Date, default: null },
    reason: { type: String, default: '', trim: true, maxlength: 300 }
  },
  { timestamps: true }
);

// One grant per rule per referral: the guard that makes both grant paths safe to retry.
referralRewardSchema.index({ referral: 1, rule: 1 }, { unique: true });

const ReferralReward = mongoose.model('ReferralReward', referralRewardSchema);

export default ReferralReward;
