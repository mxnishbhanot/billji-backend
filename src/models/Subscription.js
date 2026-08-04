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
      // The provider-side recurring subscription (Razorpay `sub_…`) that holds the mandate. This is
      // how an incoming subscription.* webhook finds its way back to a business.
      subscriptionId: { type: String, default: '', trim: true, maxlength: 160 },
      // The bank/UPI mandate or card token behind it, when the provider reports one. Display and
      // support only — never a decision input.
      mandateId: { type: String, default: '', trim: true, maxlength: 160 }
    },

    /**
     * Autopay (UPI Autopay / card e-mandate) mirror.
     *
     * Everything here is BillJi's own vocabulary and BillJi's own copy of what the provider told us.
     * Two rules that the whole feature depends on:
     *
     * 1. **A mandate is not money.** `enabled`/`status` never affect entitlements. Access is decided
     *    by currentPeriodEnd/graceEndsAt exactly as it is for a manual subscriber, so a failed debit
     *    cannot cut a paying customer off early and a live mandate cannot grant time nobody paid for.
     * 2. **`chargeAmount` is written at enrolment, before any debit.** It is the pre-agreed amount a
     *    recurring charge is checked against — the recurring equivalent of an order fixing its own
     *    amount. Never re-derive it from an event; that is what an attacker (or a mis-priced plan)
     *    would control.
     */
    autopay: {
      enabled: { type: Boolean, default: false },
      status: {
        type: String,
        enum: ['none', 'pending', 'authenticated', 'active', 'halted', 'cancelled', 'completed'],
        default: 'none'
      },
      // What the mandate was set up to buy. The webhook-created cycle row has no client request to
      // read these from, and must never read them from the event.
      planKey: { type: String, default: '', trim: true, lowercase: true, maxlength: 60 },
      interval: { type: String, default: '', trim: true, maxlength: 10 },
      chargeAmount: paise,
      currency: { type: String, default: CURRENCY, uppercase: true, trim: true, maxlength: 3 },
      // The billingService price fingerprint this mandate was minted against, for support: it says
      // which provider plan (and therefore which price) the customer actually authorised.
      providerPlanKey: { type: String, default: '', trim: true, maxlength: 160 },
      authenticatedAt: { type: Date, default: null },
      nextDebitAt: { type: Date, default: null },
      lastChargedAt: { type: Date, default: null },
      cancelledAt: { type: Date, default: null },
      failureCount: { type: Number, default: 0, min: 0 }
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

// How a subscription.* webhook finds its business. NOT unique: uniqueness buys nothing for a lookup
// and could only make a legitimate re-enrolment fail to save. Partial rather than sparse because the
// field defaults to '' — the same reasoning as SubscriptionPayment's provider-ref indexes.
subscriptionSchema.index(
  { 'provider.subscriptionId': 1 },
  { partialFilterExpression: { 'provider.subscriptionId': { $gt: '' } } }
);
// The upcoming-debit notice and the stalled-mandate reconciliation both scan this.
subscriptionSchema.index({ 'autopay.enabled': 1, 'autopay.nextDebitAt': 1 });

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
