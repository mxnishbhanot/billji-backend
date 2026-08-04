import mongoose from 'mongoose';

// One counter row per (business, period, metric). Fully generic: the engine has no idea what
// `documents_per_month` means, which is exactly why `api_calls_per_month` or `ai_credits_per_month`
// need no code change to start metering.
//
// The monthly reset is not a job. A new month produces a new periodKey, which produces a new
// document starting at 0 — that IS the reset. Nothing to schedule, nothing to get stuck.

const subscriptionUsageSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    // 'YYYY-MM' for period:'month' limits, 'all_time' for the rest.
    periodKey: { type: String, required: true, trim: true, maxlength: 20 },
    // A limit key from constants/entitlements.js (LIMIT_DEFINITIONS with metered:true).
    metric: { type: String, required: true, trim: true, maxlength: 60 },
    count: { type: Number, required: true, default: 0, min: 0 },
    // The ceiling in force when this period opened. Kept so "was this business blocked because
    // they were over, or because we changed the plan mid-month?" is answerable after the fact.
    limitAtTime: { type: Number, default: null },
    // Usage accepted past the ceiling. Only the sync path writes this: an invoice created
    // offline is already printed and in a customer's hands, so it is counted and flagged,
    // never rejected. A non-zero value is the upgrade-prompt trigger.
    overage: { type: Number, required: true, default: 0, min: 0 },
    lastAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// This uniqueness is load-bearing, not hygiene: the guarded atomic upsert in usageService
// relies on a duplicate-key error to mean "row exists and is already at the ceiling". Without
// the index, two concurrent creates both insert and both pass.
subscriptionUsageSchema.index({ business: 1, periodKey: 1, metric: 1 }, { unique: true });
// Retention sweep for old periods.
subscriptionUsageSchema.index({ periodKey: 1 });

const SubscriptionUsage = mongoose.model('SubscriptionUsage', subscriptionUsageSchema);

export default SubscriptionUsage;
