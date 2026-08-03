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

    // Same field shape the existing Payment model already uses for provider metadata.
    providerRefs: {
      orderId: { type: String, default: '', trim: true, maxlength: 160 },
      paymentId: { type: String, default: '', trim: true, maxlength: 160 },
      signature: { type: String, default: '', trim: true, maxlength: 500 },
      invoiceId: { type: String, default: '', trim: true, maxlength: 160 },
      refundId: { type: String, default: '', trim: true, maxlength: 160 }
    },
    // Webhook dedup key. The unique index below is what makes redelivery a no-op rather than a
    // double activation.
    webhookEventId: { type: String, default: '', trim: true, maxlength: 160 },

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
setProviderRef('webhookEventId');

const SubscriptionPayment = mongoose.model('SubscriptionPayment', subscriptionPaymentSchema);

export default SubscriptionPayment;
