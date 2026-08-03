import mongoose from 'mongoose';
import { BILLING_INTERVALS, CURRENCY, SUBSCRIPTION_STATUSES } from '../constants/entitlements.js';
import { assertKnownEntitlementKeys, entitlementsSchema, paise } from './Plan.js';

// One live subscription per business. Business is the isolation boundary everywhere else in
// this codebase (every model carries `business`), so billing follows it: a user who belongs
// to two businesses has two independent plans.

const subscriptionSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
    // The plan id is the durable link. Plan *names* and *keys* are editable marketing data;
    // never branch on planKey.
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
    // Denormalized for admin filters, analytics and support conversations only.
    planKey: { type: String, required: true, trim: true, lowercase: true, maxlength: 60, index: true },
    // Which version of that plan was snapshotted, so a past state is reconstructible.
    planVersion: { type: Number, default: 1, min: 1 },

    // Stored status is the *intent* recorded at the last transition. The effective status is
    // always recomputed from the dates below by subscriptionService.resolveStatus(), because a
    // stored status would grant access to an expired subscription until some job got round to it.
    status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'active', index: true },
    billingInterval: { type: String, enum: BILLING_INTERVALS, default: 'free' },

    /**
     * THE SNAPSHOT. Copied from the plan at activation/renewal and never re-read from it.
     *
     * This is the load-bearing decision of the whole billing design: an admin editing the Pro
     * plan must not retroactively change what an existing subscriber bought. It also makes
     * grandfathering, price-for-life, per-customer enterprise deals, "build your own plan" and
     * add-ons expressible with no schema change — they are all just a different snapshot.
     */
    entitlements: { type: entitlementsSchema, default: () => ({}) },

    currentPeriodStart: { type: Date, default: () => new Date() },
    // null = never expires (free, lifetime, grandfathered).
    currentPeriodEnd: { type: Date, default: null },
    // currentPeriodEnd + plan.grace.days, precomputed so status resolution stays date arithmetic
    // on this document alone and needs no plan lookup.
    graceEndsAt: { type: Date, default: null },

    trial: {
      used: { type: Boolean, default: false },
      startedAt: { type: Date, default: null },
      endsAt: { type: Date, default: null },
      planKey: { type: String, default: '', trim: true }
    },

    cancel: {
      requestedAt: { type: Date, default: null },
      // When access actually stops. Cancelling mid-period keeps access to period end.
      effectiveAt: { type: Date, default: null },
      atPeriodEnd: { type: Boolean, default: true },
      reason: { type: String, default: '', trim: true, maxlength: 500 }
    },

    // Schema only — future-ready, no pause logic implemented anywhere.
    pause: {
      pausedAt: { type: Date, default: null },
      resumesAt: { type: Date, default: null }
    },

    // What this business actually pays, which may differ from the plan's current price forever
    // (founding-member pricing, negotiated enterprise rate). locked = renewals must not reprice.
    pricing: {
      currency: { type: String, default: CURRENCY, uppercase: true, trim: true, maxlength: 3 },
      amount: paise,
      compareAtAmount: paise,
      locked: { type: Boolean, default: false }
    },

    coupon: {
      code: { type: String, default: '', trim: true, uppercase: true, maxlength: 40 },
      couponId: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', default: null },
      discountApplied: paise,
      appliesUntil: { type: Date, default: null }
    },

    // Which processor last took money. Business logic never reads this to decide anything —
    // it exists for reconciliation, refunds and future mandates.
    provider: {
      name: { type: String, default: '', trim: true, maxlength: 40 },
      customerId: { type: String, default: '', trim: true, maxlength: 160 },
      subscriptionId: { type: String, default: '', trim: true, maxlength: 160 },
      // Reserved for UPI Autopay / card mandates when auto-renewal lands. V1 is manual renewal.
      mandateId: { type: String, default: '', trim: true, maxlength: 160 }
    },

    // Schema only — no add-on service or routes exist. Present so selling extra businesses,
    // seats, storage or AI credits later needs no migration: an add-on's grants merge over
    // the snapshot in entitlementService.
    addOns: {
      type: [
        new mongoose.Schema(
          {
            addOnKey: { type: String, required: true, trim: true, maxlength: 60 },
            name: { type: String, default: '', trim: true, maxlength: 120 },
            quantity: { type: Number, default: 1, min: 0 },
            status: { type: String, enum: ['active', 'expired', 'cancelled'], default: 'active' },
            grants: { type: entitlementsSchema, default: () => ({}) },
            expiresAt: { type: Date, default: null }
          },
          { _id: false }
        )
      ],
      default: []
    },

    /**
     * Per-customer deltas applied *over* the snapshot. This is how Enterprise ("unlimited
     * everything, custom pricing") works without minting a Plan row per customer, and how
     * support grants a one-off allowance. Always narrower in scope than the snapshot, always
     * auditable via SubscriptionHistory.
     */
    overrides: { type: entitlementsSchema, default: () => ({}) },

    // Sales/ops free text. Never read by code.
    notes: { type: String, default: '', trim: true, maxlength: 2000 }
  },
  { timestamps: true }
);

// Dunning + expiry scans walk this. currentPeriodEnd:null (never expires) sorts first and is
// cheap to skip.
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
subscriptionSchema.index({ planKey: 1, status: 1 });
subscriptionSchema.index({ 'trial.endsAt': 1 }, { sparse: true });

subscriptionSchema.pre('validate', function validateEntitlementKeys(next) {
  try {
    assertKnownEntitlementKeys(this.entitlements?.features, this.entitlements?.limits);
    assertKnownEntitlementKeys(this.overrides?.features, this.overrides?.limits);
    next();
  } catch (error) {
    next(error);
  }
});

const Subscription = mongoose.model('Subscription', subscriptionSchema);

export default Subscription;
