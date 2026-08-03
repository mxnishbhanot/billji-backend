import mongoose from 'mongoose';
import { CURRENCY } from '../constants/entitlements.js';
import { paise } from './Plan.js';

// Coupons and their redemptions live in one file because they are 1:1 coupled — nothing ever
// imports one without the other.
//
// Schema only in this phase; couponService (validate/price/redeem) lands with checkout in Phase 3.

export const COUPON_TYPES = ['percent', 'fixed', 'trial_extension', 'free_period'];

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40, unique: true },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    type: { type: String, enum: COUPON_TYPES, required: true },
    // percent -> 1..100. fixed -> paise off. trial_extension / free_period -> number of days.
    value: { type: Number, required: true, min: 0 },
    currency: { type: String, default: CURRENCY, uppercase: true, trim: true, maxlength: 3 },
    // Empty arrays mean "any". Plan keys rather than ids so a coupon survives a plan being
    // cloned or re-seeded.
    appliesTo: {
      planKeys: { type: [String], default: [] },
      intervals: { type: [String], default: [] }
    },
    // Discount repeats for this many billing periods. 1 = first payment only.
    durationInPeriods: { type: Number, default: 1, min: 1 },
    firstTimeOnly: { type: Boolean, default: false },
    // null = uncapped.
    maxRedemptions: { type: Number, default: null, min: 1 },
    maxRedemptionsPerBusiness: { type: Number, default: 1, min: 1 },
    // Incremented by a guarded atomic $inc, never by read-then-write — a coupon that goes viral
    // must not be redeemable past its cap under concurrency.
    redemptionCount: { type: Number, default: 0, min: 0 },
    validFrom: { type: Date, default: () => new Date() },
    validUntil: { type: Date, default: null },
    status: { type: String, enum: ['active', 'disabled', 'expired'], default: 'active', index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

couponSchema.index({ status: 1, validUntil: 1 });

const couponRedemptionSchema = new mongoose.Schema(
  {
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: 'Coupon', required: true },
    // Denormalized so a redemption record stays readable if the coupon row is deleted.
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPayment', default: null },
    discountAmount: paise,
    redeemedAt: { type: Date, default: () => new Date() }
  },
  { timestamps: true }
);

couponRedemptionSchema.index({ coupon: 1, business: 1 });
couponRedemptionSchema.index({ business: 1, redeemedAt: -1 });

export const CouponRedemption = mongoose.model('CouponRedemption', couponRedemptionSchema);

const Coupon = mongoose.model('Coupon', couponSchema);

export default Coupon;
