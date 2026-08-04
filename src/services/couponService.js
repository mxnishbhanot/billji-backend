import Coupon, { CouponRedemption } from '../models/Coupon.js';
import { ApiError } from '../utils/ApiError.js';

// Coupons. Validation is a pure function of the coupon row and the purchase being attempted, so
// the same code answers "is this code any good?" (dry run, before checkout) and "charge this
// discounted amount" (during checkout) — there is no second implementation to drift.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Looks a coupon up and rejects it with a reason the user can act on.
 *
 * @param {{code:string, planKey:string, interval:string, business:ObjectId}} input
 * @returns {Promise<{coupon, reason:string|null}>} reason is null when the coupon applies
 */
export const findApplicableCoupon = async ({ code, planKey, interval, business, now = new Date() }) => {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return { coupon: null, reason: 'Enter a coupon code' };

  const coupon = await Coupon.findOne({ code: normalized });
  if (!coupon) return { coupon: null, reason: 'That coupon code is not valid' };
  if (coupon.status !== 'active') return { coupon, reason: 'That coupon is no longer active' };
  if (coupon.validFrom && coupon.validFrom > now) return { coupon, reason: 'That coupon is not active yet' };
  if (coupon.validUntil && coupon.validUntil < now) return { coupon, reason: 'That coupon has expired' };

  // Empty appliesTo arrays mean "any plan / any interval".
  if (coupon.appliesTo?.planKeys?.length && !coupon.appliesTo.planKeys.includes(planKey)) {
    return { coupon, reason: 'That coupon does not apply to this plan' };
  }
  if (coupon.appliesTo?.intervals?.length && !coupon.appliesTo.intervals.includes(interval)) {
    return { coupon, reason: 'That coupon does not apply to this billing period' };
  }

  if (coupon.maxRedemptions !== null && coupon.redemptionCount >= coupon.maxRedemptions) {
    return { coupon, reason: 'That coupon has been fully redeemed' };
  }

  const used = await CouponRedemption.countDocuments({ coupon: coupon._id, business });
  if (used >= (coupon.maxRedemptionsPerBusiness || 1)) {
    return { coupon, reason: 'You have already used that coupon' };
  }

  if (coupon.firstTimeOnly) {
    const everPaid = await CouponRedemption.countDocuments({ business });
    if (everPaid > 0) return { coupon, reason: 'That coupon is for first-time purchases only' };
  }

  return { coupon, reason: null };
};

/**
 * The discount a coupon takes off an amount, in paise.
 *
 * Never returns more than the amount itself — a coupon must not produce a negative charge, and a
 * ₹500-off code on a ₹249 plan is a free month, not ₹251 owed to the customer. `trial_extension`
 * and `free_period` take nothing off the price; they extend time instead (see `timeGrant`).
 */
export const discountFor = (coupon, amount) => {
  if (!coupon || !amount) return 0;

  switch (coupon.type) {
    case 'percent':
      // Round down: the customer keeps the fraction of a paisa, not us.
      return Math.min(amount, Math.floor((amount * Math.min(coupon.value, 100)) / 100));
    case 'fixed':
      return Math.min(amount, Math.max(0, Math.round(coupon.value)));
    default:
      return 0;
  }
};

/** Extra days a time-based coupon grants, for the trial and free-period types. */
export const timeGrant = (coupon) =>
  coupon && ['trial_extension', 'free_period'].includes(coupon.type) ? Math.max(0, coupon.value) * DAY_MS : 0;

/**
 * Claims one redemption slot atomically, then records who used it.
 *
 * The `$expr`-free guard below is the whole point: a read-then-write would let a coupon that goes
 * viral be redeemed past its cap by concurrent checkouts. `maxRedemptions: null` (uncapped) skips
 * the predicate but still increments, so reporting stays accurate. Same idiom as the usage counter.
 */
export const redeemCoupon = async ({ coupon, business, subscription = null, payment = null, discountAmount = 0 }) => {
  const guard =
    coupon.maxRedemptions === null
      ? { _id: coupon._id }
      : { _id: coupon._id, redemptionCount: { $lt: coupon.maxRedemptions } };

  const claimed = await Coupon.findOneAndUpdate(guard, { $inc: { redemptionCount: 1 } }, { new: true });
  if (!claimed) {
    throw new ApiError(409, 'That coupon has been fully redeemed', { code: 'COUPON_EXHAUSTED' });
  }

  await CouponRedemption.create({
    coupon: coupon._id,
    code: coupon.code,
    business,
    subscription,
    payment,
    discountAmount
  });

  return claimed;
};

/**
 * Returns a claimed slot. Called when the payment the coupon was claimed for never completes —
 * otherwise an abandoned checkout would silently burn a redemption.
 */
export const releaseCoupon = async ({ coupon, business, payment = null }) => {
  const deleted = await CouponRedemption.findOneAndDelete({
    coupon: coupon._id || coupon,
    business,
    ...(payment ? { payment } : {})
  });
  if (!deleted) return null;

  // Guarded so a double release cannot drive the counter negative.
  return Coupon.findOneAndUpdate({ _id: coupon._id || coupon, redemptionCount: { $gt: 0 } }, { $inc: { redemptionCount: -1 } }, { new: true });
};
