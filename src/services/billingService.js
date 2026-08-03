import Coupon from '../models/Coupon.js';
import Plan from '../models/Plan.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import { CURRENCY } from '../constants/entitlements.js';
import { ApiError } from '../utils/ApiError.js';
import { discountFor, findApplicableCoupon, redeemCoupon, releaseCoupon, timeGrant } from './couponService.js';
import { DEFAULT_PROVIDER, getProvider } from './payments/index.js';
import { applyPlan, cancelSubscription, getSubscription, resolveStatus } from './subscriptionService.js';

// Checkout orchestration — the ONLY module that talks to a payment provider.
//
// The split that matters: this file decides *what* to charge and *what it buys*; a provider only
// confirms money moved. Razorpay never tells BillJi which plan, which period, or which
// entitlements — those are computed here and snapshotted by subscriptionService.

const asPaise = (value) => Math.max(0, Math.round(value));

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Unused value of the period the business already paid for, credited against an upgrade.
 *
 * Without this, upgrading mid-period means paying twice for the same days and nobody upgrades
 * until their period ends. Straight-line by remaining days, floored — we round in the customer's
 * favour on the discount and never credit more than they paid.
 *
 * ponytail: straight-line, day-granularity, credit-only (never a refund and never carried
 * forward). Good enough while there is one currency and no auto-renew; revisit if invoicing needs
 * exact per-second proration.
 */
export const prorationCredit = ({ subscription, now = new Date() }) => {
  const { currentPeriodStart: start, currentPeriodEnd: end } = subscription || {};
  const paid = subscription?.pricing?.amount || 0;

  if (!paid || !start || !end || end <= now) return 0;
  if (!['active', 'in_grace'].includes(resolveStatus(subscription, now))) return 0;

  const total = end.getTime() - new Date(start).getTime();
  if (total <= 0) return 0;

  const remaining = Math.max(0, end.getTime() - now.getTime());
  return Math.min(paid, Math.floor((paid * remaining) / total));
};

/**
 * What this purchase costs, itemised. Pure apart from the coupon lookup, so the checkout endpoint
 * and the "does this code work?" endpoint cannot disagree about a price.
 */
export const quote = async ({ business, plan, interval, couponCode = '', now = new Date() }) => {
  const price = plan.priceFor(interval);
  if (!price) {
    throw new ApiError(400, 'That plan is not available on this billing period', { code: 'PRICE_NOT_AVAILABLE' });
  }

  const subscription = await getSubscription(business._id || business);
  const gross = asPaise(price.amount);

  const { coupon, reason } = couponCode
    ? await findApplicableCoupon({ code: couponCode, planKey: plan.key, interval, business: business._id || business, now })
    : { coupon: null, reason: null };

  // A bad code must not silently become a full-price charge — the caller decides whether to refuse
  // or to re-quote without it.
  if (couponCode && reason) {
    return { valid: false, couponError: reason, coupon: null, gross, discount: 0, credit: 0, netAmount: gross, currency: price.currency || CURRENCY, interval, bonusMs: 0 };
  }

  const discount = discountFor(coupon, gross);
  // Only credit when moving to a different plan. Renewing the same plan already extends from the
  // existing period end, so crediting there would pay the customer twice for the same days.
  const changingPlan = subscription && String(subscription.plan) !== String(plan._id);
  const credit = changingPlan ? prorationCredit({ subscription, now }) : 0;

  return {
    valid: true,
    couponError: null,
    coupon,
    gross,
    discount,
    credit,
    netAmount: Math.max(0, gross - discount - credit),
    currency: price.currency || CURRENCY,
    interval,
    intervalCount: price.intervalCount || 1,
    // trial_extension / free_period coupons buy time instead of taking money off.
    bonusMs: timeGrant(coupon)
  };
};

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

const resolvePurchasablePlan = async ({ planId, planKey, business }) => {
  const plan = planId ? await Plan.findById(planId) : await Plan.findOne({ key: planKey });
  if (!plan || plan.status !== 'active') {
    throw new ApiError(404, 'That plan is not available', { code: 'PLAN_NOT_AVAILABLE' });
  }

  if (plan.visibility !== 'public') {
    // Private plans (Enterprise, grandfathering) are assigned by a human after a conversation.
    // Letting a client name one in a checkout body would be a self-serve path to custom pricing.
    const subscription = await getSubscription(business._id || business);
    if (String(subscription?.plan || '') !== String(plan._id)) {
      throw new ApiError(403, 'That plan is not available for self-serve purchase. Please contact us.', {
        code: 'PLAN_REQUIRES_SALES_CONTACT'
      });
    }
  }

  return plan;
};

/**
 * Opens a checkout: records our intent as a `created` payment, then asks the provider for an order.
 *
 * Our row is written FIRST. If the provider call then fails we hold an abandoned `created` row,
 * which is harmless; the other order would leave an order at Razorpay that BillJi has no record of
 * — money could be taken against something we cannot match to a business.
 *
 * Route-level idempotency (middlewares/idempotency.js) makes a retried tap replay the first
 * response rather than open a second order.
 */
export const createCheckout = async ({
  user,
  business,
  planId = null,
  planKey = null,
  interval,
  couponCode = '',
  provider: providerName = DEFAULT_PROVIDER,
  now = new Date()
}) => {
  const plan = await resolvePurchasablePlan({ planId, planKey, business });
  const priced = await quote({ business, plan, interval, couponCode, now });

  if (!priced.valid) {
    throw new ApiError(422, priced.couponError, { code: 'COUPON_NOT_APPLICABLE' });
  }
  if (priced.netAmount <= 0) {
    // Nothing to charge: either a free plan or a discount that covers the whole price. Both need a
    // grant path, not a payment path — refuse rather than send a ₹0 order to a gateway that will
    // reject it with a confusing error.
    throw new ApiError(422, 'There is nothing to pay for this plan. Contact support to have it applied.', {
      code: 'NOTHING_TO_CHARGE',
      netAmount: priced.netAmount
    });
  }

  const provider = getProvider(providerName);
  const subscription = await getSubscription(business._id);

  const payment = await SubscriptionPayment.create({
    business: business._id,
    subscription: subscription?._id || null,
    kind: subscription && String(subscription.plan) !== String(plan._id) ? 'upgrade' : subscription ? 'renewal' : 'subscription',
    provider: provider.name,
    status: 'created',
    amount: priced.gross,
    discount: priced.discount + priced.credit,
    netAmount: priced.netAmount,
    currency: priced.currency,
    planKey: plan.key,
    billingInterval: interval,
    couponCode: priced.coupon?.code || '',
    receipt: { number: await nextReceiptNumber(now) }
  });

  let order;
  try {
    order = await provider.createOrder({
      amount: priced.netAmount,
      currency: priced.currency,
      receipt: payment.receipt.number,
      // Notes come back on every webhook, which is how an event is matched to a business even if
      // our own lookup by order id ever fails.
      notes: { billjiPaymentId: String(payment._id), businessId: String(business._id), planId: String(plan._id), interval }
    });
  } catch (error) {
    payment.status = 'failed';
    payment.failureReason = String(error.message).slice(0, 500);
    await payment.save();
    throw error;
  }

  payment.providerRefs.orderId = order.providerOrderId;
  payment.raw = order.raw;
  await payment.save();

  return {
    paymentId: String(payment._id),
    orderId: order.providerOrderId,
    amount: priced.netAmount,
    currency: priced.currency,
    provider: provider.name,
    providerConfig: provider.publicConfig(),
    plan: { planId: String(plan._id), planKey: plan.key, name: plan.name },
    interval,
    breakdown: { gross: priced.gross, discount: priced.discount, proratedCredit: priced.credit, netAmount: priced.netAmount },
    couponCode: priced.coupon?.code || '',
    // The customer's own name/email/phone for the checkout form. No card data ever reaches BillJi.
    prefill: { name: user.name, email: user.email, contact: business.phone || '' }
  };
};

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Turns a confirmed payment into an active subscription. Called by BOTH the client verify path and
 * the webhook, whichever lands first.
 *
 * The `status: created|authorized` predicate is the whole concurrency story: exactly one caller
 * wins the transition to `captured`, and the loser returns the already-activated subscription
 * instead of extending the period a second time. Doing this as one atomic update rather than
 * "check then write" is what makes a webhook redelivery racing the client harmless.
 */
export const activateFromPayment = async ({ payment, providerPaymentId = '', eventId = '', actor = { type: 'system' }, now = new Date() }) => {
  const claimed = await SubscriptionPayment.findOneAndUpdate(
    { _id: payment._id, status: { $in: ['created', 'authorized'] } },
    {
      $set: {
        status: 'captured',
        ...(providerPaymentId ? { 'providerRefs.paymentId': providerPaymentId } : {})
      },
      ...(eventId ? { $addToSet: { webhookEventIds: eventId } } : {})
    },
    { new: true }
  );

  if (!claimed) {
    // Already captured (or failed). Idempotent by construction: report the current state.
    const current = await SubscriptionPayment.findById(payment._id);
    return { payment: current, subscription: await getSubscription(current.business), alreadyApplied: true };
  }

  const plan = await Plan.findOne({ key: claimed.planKey });
  if (!plan) {
    // Money is captured and the plan row is gone. Never lose the payment — leave it captured, flag
    // it, and let support resolve it by hand rather than rolling back a real charge.
    claimed.failureReason = `Plan ${claimed.planKey} no longer exists; activation needs manual review`;
    await claimed.save();
    throw new ApiError(500, 'Payment received but the plan could not be applied. Support has been notified.', {
      code: 'ACTIVATION_PLAN_MISSING'
    });
  }

  const existing = await getSubscription(claimed.business);
  const isRenewal = existing && String(existing.plan) === String(plan._id);
  const bonusMs = claimed.couponCode ? await bonusMsForCoupon(claimed.couponCode) : 0;

  const subscription = await applyPlan({
    business: claimed.business,
    plan,
    interval: claimed.billingInterval,
    action: isRenewal ? 'renewed' : existing ? 'upgraded' : 'activated',
    actor,
    now,
    amount: claimed.netAmount,
    currency: claimed.currency,
    metadata: { paymentId: String(claimed._id), provider: claimed.provider, couponCode: claimed.couponCode }
  });

  // A free-period / trial-extension coupon buys time, applied after the period is set.
  if (bonusMs > 0 && subscription.currentPeriodEnd) {
    subscription.currentPeriodEnd = new Date(subscription.currentPeriodEnd.getTime() + bonusMs);
    subscription.graceEndsAt = subscription.graceEndsAt ? new Date(subscription.graceEndsAt.getTime() + bonusMs) : null;
    await subscription.save();
  }

  claimed.subscription = subscription._id;
  claimed.periodStart = subscription.currentPeriodStart;
  claimed.periodEnd = subscription.currentPeriodEnd;
  await claimed.save();

  if (claimed.couponCode) {
    const { coupon } = await findApplicableCoupon({
      code: claimed.couponCode,
      planKey: plan.key,
      interval: claimed.billingInterval,
      business: claimed.business,
      now
    });
    // Redeem against the coupon row even if it has since become inapplicable — the customer already
    // paid the discounted amount, so the redemption is a fact to record, not a decision to re-make.
    if (coupon) {
      await redeemCoupon({
        coupon,
        business: claimed.business,
        subscription: subscription._id,
        payment: claimed._id,
        discountAmount: claimed.discount
      }).catch((error) => console.error('[billing] coupon redemption failed after payment:', error.message));
    }
  }

  return { payment: claimed, subscription, alreadyApplied: false };
};

// Read the row directly: applicability was already decided when the price was quoted, and the
// customer has since paid that price.
const bonusMsForCoupon = async (code) => timeGrant(await Coupon.findOne({ code }));

/**
 * The client-confirm path. Fast, for UX — the webhook remains the authority, and whichever arrives
 * first activates.
 *
 * Two independent checks before anything is granted: the HMAC proves Razorpay produced this
 * order/payment pair, and the re-fetch proves the payment is actually captured for the amount we
 * asked. The signature alone would let a client replay a genuine pair from a *different*,
 * unfinished payment attempt.
 */
export const verifyCheckout = async ({ business, orderId, paymentId, signature, now = new Date() }) => {
  const payment = await SubscriptionPayment.findOne({ business: business._id, 'providerRefs.orderId': orderId });
  if (!payment) throw new ApiError(404, 'Unknown payment order', { code: 'PAYMENT_NOT_FOUND' });

  if (payment.status === 'captured') {
    return { payment, subscription: await getSubscription(business._id), alreadyApplied: true };
  }

  if (payment.provider === 'manual') {
    throw new ApiError(400, 'This payment is confirmed by our team once the transfer arrives', {
      code: 'PAYMENT_CONFIRMED_MANUALLY'
    });
  }

  const provider = getProvider(payment.provider);
  if (!provider.verifyPaymentSignature({ orderId, paymentId, signature })) {
    // Note it, but do NOT mark the payment failed. A bad signature is a client-side problem (a bug,
    // a replay, a tamper attempt) and says nothing about whether money moved. Failing the row here
    // would lock out the genuine `payment.captured` webhook, which only activates from
    // created/authorized — so a customer who really paid could never be activated.
    payment.failureReason = 'Client signature verification failed';
    await payment.save();
    throw new ApiError(400, 'Payment could not be verified', { code: 'PAYMENT_SIGNATURE_INVALID' });
  }

  const remote = await provider.fetchPayment(paymentId);
  if (remote.orderId !== orderId) {
    throw new ApiError(400, 'Payment does not belong to this order', { code: 'PAYMENT_ORDER_MISMATCH' });
  }
  if (!remote.captured) {
    throw new ApiError(409, 'Payment is not complete yet', { code: 'PAYMENT_NOT_CAPTURED', providerStatus: remote.status });
  }
  if (remote.amount !== payment.netAmount) {
    // Should be impossible — the order fixed the amount — so treat it as tampering, not a rounding
    // difference, and refuse to grant anything.
    throw new ApiError(400, 'Payment amount does not match the order', {
      code: 'PAYMENT_AMOUNT_MISMATCH',
      expected: payment.netAmount,
      received: remote.amount
    });
  }

  payment.raw = remote.raw;
  await payment.save();

  return activateFromPayment({ payment, providerPaymentId: paymentId, actor: { type: 'user' }, now });
};

/** Records a payment as failed. Releases nothing else — a failed attempt grants nothing. */
export const failPayment = async ({ payment, reason = '', eventId = '' }) => {
  const failed = await SubscriptionPayment.findOneAndUpdate(
    { _id: payment._id, status: { $in: ['created', 'authorized'] } },
    {
      $set: { status: 'failed', failureReason: String(reason).slice(0, 500) },
      ...(eventId ? { $addToSet: { webhookEventIds: eventId } } : {})
    },
    { new: true }
  );

  return failed || SubscriptionPayment.findById(payment._id);
};

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

/**
 * Refunds through the provider and shortens access to match.
 *
 * A refund that leaves the subscription running is a free plan, so a full refund ends the period
 * now. A partial refund does not — the customer kept part of what they bought.
 */
export const refundPayment = async ({ payment, amount = null, reason = '', actor = { type: 'admin' }, now = new Date() }) => {
  if (payment.status !== 'captured' && payment.status !== 'partially_refunded') {
    throw new ApiError(409, 'Only a captured payment can be refunded', { code: 'PAYMENT_NOT_REFUNDABLE' });
  }

  const alreadyRefunded = payment.refundedAmount || 0;
  const refundable = payment.netAmount - alreadyRefunded;
  const requested = amount === null ? refundable : asPaise(amount);

  if (requested <= 0 || requested > refundable) {
    throw new ApiError(422, 'Refund amount exceeds what is left to refund', {
      code: 'REFUND_AMOUNT_INVALID',
      refundable
    });
  }

  const provider = getProvider(payment.provider);
  const refund = await provider.refund({
    paymentId: payment.providerRefs.paymentId,
    amount: requested,
    notes: { reason: String(reason).slice(0, 200) }
  });

  return applyRefund({ payment, refundId: refund.refundId, amount: requested, actor, now });
};

/**
 * Writes a refund's consequences. Shared by the admin-initiated path and the provider webhook (a
 * refund issued from the Razorpay dashboard arrives only as an event).
 */
export const applyRefund = async ({ payment, refundId = '', amount, eventId = '', actor = { type: 'system' }, now = new Date() }) => {
  const total = (payment.refundedAmount || 0) + asPaise(amount);
  const full = total >= payment.netAmount;

  const updated = await SubscriptionPayment.findOneAndUpdate(
    { _id: payment._id, ...(eventId ? { webhookEventIds: { $ne: eventId } } : {}) },
    {
      $set: {
        status: full ? 'refunded' : 'partially_refunded',
        refundedAmount: Math.min(total, payment.netAmount),
        refundedAt: now,
        ...(refundId ? { 'providerRefs.refundId': refundId } : {})
      },
      ...(eventId ? { $addToSet: { webhookEventIds: eventId } } : {})
    },
    { new: true }
  );

  // No match means this exact event was already applied.
  if (!updated) return { payment: await SubscriptionPayment.findById(payment._id), alreadyApplied: true };

  if (full) {
    // Give the redemption slot back — a fully refunded purchase did not consume the coupon.
    if (payment.couponCode) {
      const coupon = await Coupon.findOne({ code: payment.couponCode });
      if (coupon) await releaseCoupon({ coupon, business: payment.business, payment: payment._id }).catch(() => {});
    }

    const subscription = await getSubscription(payment.business);
    // Only end the period this payment actually bought. A refund of an old payment must not revoke
    // a later one the customer has already paid for.
    if (subscription && payment.periodEnd && subscription.currentPeriodEnd?.getTime() === payment.periodEnd.getTime()) {
      await cancelSubscription({
        business: subscription.business,
        reason: `Refunded payment ${payment._id}`,
        immediate: true,
        actor,
        now
      });
    }
  }

  return { payment: updated, alreadyApplied: false };
};

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/**
 * Sequential receipt number, e.g. BILLJI/2026-27/000123.
 *
 * A NUMBER only. This is deliberately NOT a GST tax invoice: issuing one needs BillJi's own GSTIN,
 * the SAC code for the service, and a place-of-supply rule to pick IGST vs CGST+SGST from the
 * customer's state — all product/compliance decisions, not engineering ones. The number is
 * allocated now so the sequence is continuous from the first rupee; the document waits for those
 * answers (see docs §14.6).
 */
export const nextReceiptNumber = async (now = new Date()) => {
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const financialYear = `${year}-${String(year + 1).slice(-2)}`;
  const prefix = `BILLJI/${financialYear}/`;

  const last = await SubscriptionPayment.findOne({ 'receipt.number': new RegExp(`^${prefix.replace(/\//g, '\\/')}`) })
    .sort({ 'receipt.number': -1 })
    .select('receipt.number');

  const previous = last ? Number(String(last.receipt.number).split('/').pop()) : 0;
  return `${prefix}${String(previous + 1).padStart(6, '0')}`;
};

// Abandoned checkouts are noise in a customer-facing history.
export const listPayments = ({ business, limit = 50, skip = 0 }) =>
  SubscriptionPayment.find({ business: business._id || business, status: { $ne: 'created' } })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
