import mongoose from 'mongoose';
import { BILLING_INTERVALS, CURRENCY } from '../constants/entitlements.js';
import { paise } from './Plan.js';

// BillJi's OWN revenue: money a business pays BillJi.
//
// Deliberately NOT the existing `Payment` collection, which records money a *customer* pays a
// *business* and feeds LedgerEntry, CustomerBalance and the GST returns. Mixing SaaS revenue
// into that would corrupt every one of those reports.
//
// Schema only in this phase — no checkout, no webhooks, no provider calls yet (Phase 3).

export const PAYMENT_KINDS = ['subscription', 'renewal', 'upgrade', 'addon', 'manual'];

// Providers are code, not data (a database row cannot implement Stripe). This list is the set
// of provider implementations the abstraction is designed for; only razorpay + manual are
// planned for Phase 3.
export const PAYMENT_PROVIDERS = ['razorpay', 'stripe', 'manual', 'bank_transfer', 'upi_manual', 'enterprise_invoice'];

export const PAYMENT_STATUSES = ['created', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'];

const subscriptionPaymentSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null },
    kind: { type: String, enum: PAYMENT_KINDS, default: 'subscription' },
    provider: { type: String, enum: PAYMENT_PROVIDERS, required: true },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'created', index: true },

    // All integer paise. netAmount = amount + tax - discount, computed by the billing service.
    amount: paise,
    tax: paise,
    discount: paise,
    netAmount: paise,
    currency: { type: String, default: CURRENCY, uppercase: true, trim: true, maxlength: 3 },

    // What was bought, frozen at purchase time — the plan row may change or be archived later.
    planKey: { type: String, default: '', trim: true, maxlength: 60 },
    billingInterval: { type: String, enum: BILLING_INTERVALS, default: 'month' },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    couponCode: { type: String, default: '', trim: true, uppercase: true, maxlength: 40 },
    /**
     * The proration credit inside `discount`, plus the period end it was computed from.
     *
     * Recorded so the credit is auditable and so activation can tell that the period the credit was
     * priced against has since moved — meaning a second, simultaneous checkout already spent it.
     * `discount` alone could not express that: it merges the coupon discount and the credit.
     */
    proratedCredit: paise,
    creditBasisPeriodEnd: { type: Date, default: null },

    // Same field shape the existing Payment model already uses for provider metadata.
    providerRefs: {
      orderId: { type: String, default: '', trim: true, maxlength: 160 },
      paymentId: { type: String, default: '', trim: true, maxlength: 160 },
      signature: { type: String, default: '', trim: true, maxlength: 500 },
      invoiceId: { type: String, default: '', trim: true, maxlength: 160 },
      refundId: { type: String, default: '', trim: true, maxlength: 160 },
      /**
       * The autopay mandate this cycle was debited under, and the flag that says a row IS an autopay
       * cycle (there is no separate boolean — one source of truth).
       *
       * MANY rows share one value: every month of one mandate. See the index note below.
       */
      subscriptionId: { type: String, default: '', trim: true, maxlength: 160 }
    },
    /**
     * Every provider event id this payment has already applied — the webhook dedup ledger.
     *
     * An array, not a single field: one payment legitimately receives several distinct events
     * (`payment.captured`, then `refund.processed`), so a scalar would be overwritten and a
     * redelivered capture could activate twice. The handler pushes with a
     * `{ webhookEventIds: { $ne: eventId } }` guard, so a duplicate delivery matches nothing and
     * becomes a no-op in one atomic operation — no separate event collection needed.
     */
    webhookEventIds: { type: [String], default: [] },
    /**
     * Every provider refund id already applied to this payment.
     *
     * Separate from `webhookEventIds` because the natural identity of a refund is the refund, not
     * the delivery: Razorpay sends BOTH `refund.created` and `refund.processed` for one refund, with
     * two different event ids. Deduping on the event id therefore counted a single ₹500 refund as
     * ₹1000 and could cancel a subscription the customer had only partly been refunded for.
     * Keyed here instead, so the second lifecycle event of the same refund is a no-op.
     */
    refundIds: { type: [String], default: [] },

    failureReason: { type: String, default: '', trim: true, maxlength: 500 },
    refundedAmount: paise,
    refundedAt: { type: Date, default: null },

    receipt: {
      number: { type: String, default: '', trim: true, maxlength: 60 },
      url: { type: String, default: '', trim: true, maxlength: 500 }
    },

    // Raw provider payload, kept verbatim for chargeback and reconciliation disputes.
    raw: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { timestamps: true }
);

subscriptionPaymentSchema.index({ business: 1, createdAt: -1 });
subscriptionPaymentSchema.index({ status: 1, createdAt: -1 });
// Partial, not sparse. These fields default to '' rather than being absent, and a sparse index
// only skips *missing* fields — so `sparse: true` here would let the second unpaid row collide
// with the first on ''. `$gt: ''` matches any non-empty string, which is exactly the set that
// must be unique.
const setProviderRef = (field) =>
  subscriptionPaymentSchema.index({ [field]: 1 }, { unique: true, partialFilterExpression: { [field]: { $gt: '' } } });

setProviderRef('providerRefs.orderId');
setProviderRef('providerRefs.paymentId');
// DELIBERATELY NOT setProviderRef. Every cycle of one mandate carries the same subscriptionId, so
// the unique-partial pattern above would make the SECOND renewal fail to insert — a customer
// charged with nothing granted. Dedup for autopay cycles rides on the unique `providerRefs.paymentId`
// index instead (one Razorpay payment per debit); this index is only a lookup.
subscriptionPaymentSchema.index({ 'providerRefs.subscriptionId': 1, createdAt: -1 });
// A receipt number is a financial identifier: two payments holding the same one is indefensible in
// an audit. The uniqueness is enforced here as well as allocated atomically (NumberSequence) so a
// future allocator can never quietly reintroduce the collision. Same partial-index reasoning as
// above — the field defaults to ''.
subscriptionPaymentSchema.index(
  { 'receipt.number': 1 },
  { unique: true, partialFilterExpression: { 'receipt.number': { $gt: '' } } }
);
// The reconciliation job's scan: captured payments that never reached an activated subscription.
subscriptionPaymentSchema.index({ status: 1, subscription: 1, updatedAt: 1 });
// Not unique: the dedup guard is the `$ne` predicate on the update, and this index is what makes
// that predicate (and support lookups by event id) fast.
subscriptionPaymentSchema.index({ webhookEventIds: 1 });

const SubscriptionPayment = mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);

export default SubscriptionPayment;
