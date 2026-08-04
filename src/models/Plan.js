import mongoose from 'mongoose';
import { BILLING_INTERVALS, CURRENCY, PLAN_STATUSES, PLAN_VISIBILITIES, UNLIMITED, isFeatureKey, isLimitKey } from '../constants/entitlements.js';

// Amounts are integer paise. Rupee floats accumulate rounding error and would not match
// the amount a provider signs, so a non-integer here is a bug, not a rounding nuisance.
export const paise = {
  type: Number,
  default: 0,
  min: 0,
  validate: { validator: Number.isInteger, message: 'Amount must be an integer number of paise' }
};

const priceSchema = new mongoose.Schema(
  {
    interval: { type: String, enum: BILLING_INTERVALS, required: true },
    intervalCount: { type: Number, default: 1, min: 1 },
    currency: { type: String, default: CURRENCY, uppercase: true, trim: true, maxlength: 3 },
    amount: paise,
    // Strike-through "was" price. Display only — never charged.
    compareAtAmount: paise,
    // Optional provider-side price/plan ids. Present so a provider that wants its own
    // catalog can be reconciled; BillJi never reads these to decide anything.
    providerRefs: { type: Map, of: String, default: () => new Map() },
    status: { type: String, enum: ['active', 'archived'], default: 'active' }
  },
  { _id: false }
);

/**
 * Feature/limit containers are Maps, not fixed sub-schemas, so adding a feature key is a
 * catalog edit rather than a schema migration. Junk keys are still impossible: the
 * pre-validate hook below rejects anything absent from constants/entitlements.js.
 */
export const entitlementsSchema = new mongoose.Schema(
  {
    features: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => new Map() },
    limits: { type: Map, of: Number, default: () => new Map() }
  },
  { _id: false }
);

const planSchema = new mongoose.Schema(
  {
    // Immutable identity. Business logic keys off the plan _id (Subscription.plan) and off
    // the entitlement snapshot — never off this string, which exists for seeding, admin
    // filters and analytics.
    key: { type: String, required: true, trim: true, lowercase: true, maxlength: 60, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    tagline: { type: String, default: '', trim: true, maxlength: 180 },
    description: { type: String, default: '', trim: true, maxlength: 1000 },
    badge: { type: String, default: '', trim: true, maxlength: 40 },
    sortOrder: { type: Number, default: 100 },
    // private = never listed to customers (enterprise, grandfathering); hidden = temporarily
    // delisted but still honoured for anyone already on it.
    visibility: { type: String, enum: PLAN_VISIBILITIES, default: 'public', index: true },
    status: { type: String, enum: PLAN_STATUSES, default: 'active', index: true },
    // Exactly one plan is the default: where new signups land and where an expired
    // subscription falls back to. Enforced by a partial unique index below.
    isDefault: { type: Boolean, default: false },
    prices: { type: [priceSchema], default: [] },
    features: { type: Map, of: mongoose.Schema.Types.Mixed, default: () => new Map() },
    limits: { type: Map, of: Number, default: () => new Map() },
    trial: {
      enabled: { type: Boolean, default: false },
      days: { type: Number, default: 0, min: 0 }
    },
    // Days of continued access after currentPeriodEnd. A renewal that arrives late must not
    // lock a paying customer out of their own invoices.
    grace: {
      days: { type: Number, default: 0, min: 0 }
    },
    // Non-behavioural extras (support tier, marketing copy, sales flags). Nothing here is
    // ever read to make an access decision.
    meta: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // Bumped on every features/limits/price edit. Recorded on each subscription snapshot so
    // "which version of Pro did this customer buy?" is answerable years later.
    version: { type: Number, default: 1, min: 1 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

planSchema.index({ status: 1, visibility: 1, sortOrder: 1 });
// Two default plans would make "where do new signups land?" non-deterministic.
planSchema.index({ isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

/**
 * Rejects unknown feature/limit keys at write time. Without this, a typo in an admin API
 * call (`advanced_report`) creates a permission that no code path ever grants, and the
 * failure surfaces days later as "customer paid and still can't see reports".
 */
export const assertKnownEntitlementKeys = (features, limits) => {
  const featureKeys = features instanceof Map ? [...features.keys()] : Object.keys(features || {});
  const limitKeys = limits instanceof Map ? [...limits.keys()] : Object.keys(limits || {});

  const unknownFeatures = featureKeys.filter((key) => !isFeatureKey(key));
  const unknownLimits = limitKeys.filter((key) => !isLimitKey(key));

  if (unknownFeatures.length || unknownLimits.length) {
    const parts = [];
    if (unknownFeatures.length) parts.push(`features: ${unknownFeatures.join(', ')}`);
    if (unknownLimits.length) parts.push(`limits: ${unknownLimits.join(', ')}`);
    throw new Error(`Unknown entitlement keys (${parts.join(' | ')}). Add them to constants/entitlements.js first.`);
  }
};

planSchema.pre('validate', function validateEntitlementKeys(next) {
  try {
    assertKnownEntitlementKeys(this.features, this.limits);
    next();
  } catch (error) {
    next(error);
  }
});

/** Limits absent from a plan mean "no ceiling", so a new limit key never accidentally blocks anyone. */
planSchema.methods.limitFor = function limitFor(key) {
  const value = this.limits?.get(key);
  return value === undefined || value === null ? UNLIMITED : value;
};

planSchema.methods.priceFor = function priceFor(interval) {
  return this.prices?.find((price) => price.interval === interval && price.status === 'active') || null;
};

const Plan = mongoose.model('Plan', planSchema);

export default Plan;
