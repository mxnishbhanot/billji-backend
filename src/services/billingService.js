import Business from '../models/Business.js';
import Coupon, { CouponRedemption } from '../models/Coupon.js';
import Plan from '../models/Plan.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import { CURRENCY } from '../constants/entitlements.js';
import { ApiError } from '../utils/ApiError.js';
import { onPaidSubscription, reverseRewardForPayment } from '../modules/referrals/service.js';
import { logAudit } from './auditService.js';
import { discountFor, findApplicableCoupon, redeemCoupon, releaseCoupon, timeGrant } from './couponService.js';
import { nextPlatformSequence } from './numberingService.js';
import { grant as grantReward, listGrantsFor, reverse as reverseReward } from './rewardEngine.js';
import { DEFAULT_PROVIDER, getAutopayProvider, getProvider } from './payments/index.js';
import { applyPlan, cancelSubscription, ensureSubscription, getSubscription, resolveStatus } from './subscriptionService.js';

// Checkout orchestration — the ONLY module that talks to a payment provider.
//
// The split that matters: this file decides *what* to charge and *what it buys*; a provider only
// confirms money moved. Razorpay never tells BillJi which plan, which period, or which
// entitlements — those are computed here and snapshotted by subscriptionService.

const asPaise = (value) => Math.max(0, Math.round(value));
const DAY_MS = 24 * 60 * 60 * 1000;

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

// How long an unpaid checkout is still considered live. Long enough for a customer to finish a bank
// page or a UPI approval, short enough that abandoning one does not lock them out of buying.
export const CHECKOUT_HOLD_MS = 15 * 60 * 1000;

/** A still-open order for exactly these terms, or null. */
const openCheckoutFor = ({ business, plan, interval, couponCode, now }) =>
  SubscriptionPayment.findOne({
    business: business._id || business,
    status: 'created',
    planKey: plan.key,
    billingInterval: interval,
    couponCode: couponCode || '',
    'providerRefs.orderId': { $gt: '' },
    createdAt: { $gt: new Date(now.getTime() - CHECKOUT_HOLD_MS) }
  }).sort({ createdAt: -1 });

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
  autopay = false,
  now = new Date()
}) => {
  const plan = await resolvePurchasablePlan({ planId, planKey, business });

  // Autopay is a different instrument, not a different price: it buys a mandate rather than a single
  // period. Branching here keeps every line below untouched for manual purchases.
  if (autopay) {
    return createAutopayEnrolment({ user, business, plan, interval, couponCode, providerName, now });
  }

  const priced = await quote({ business, plan, interval, couponCode, now });

  const open = await openCheckoutFor({ business, plan, interval, couponCode: priced.coupon?.code || '', now });
  if (open) {
    // Same plan, same terms, still open: hand back the order we already minted rather than a second
    // one the customer could also pay. This is the server-side half of checkout idempotency — it
    // holds even when a client forgets the Idempotency-Key header.
    return resumeCheckout({ payment: open, plan, user, business });
  }

  // A different plan while a credit-bearing order is open would price the *same* unused days into
  // both, so paying both buys one plan and spends the credit twice. Refuse; the customer either pays
  // or abandons the open one first (it ages out in CHECKOUT_HOLD_MS).
  if (priced.credit > 0) {
    const conflicting = await SubscriptionPayment.findOne({
      business: business._id,
      status: 'created',
      proratedCredit: { $gt: 0 },
      createdAt: { $gt: new Date(now.getTime() - CHECKOUT_HOLD_MS) }
    }).sort({ createdAt: -1 });

    if (conflicting) {
      throw new ApiError(409, 'You already have a payment in progress. Finish or cancel it before changing plans.', {
        code: 'CHECKOUT_ALREADY_OPEN',
        paymentId: String(conflicting._id),
        planKey: conflicting.planKey,
        interval: conflicting.billingInterval
      });
    }
  }

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
    proratedCredit: priced.credit,
    // What the credit was computed from. Activation compares this to the live period end to notice
    // that another checkout has since spent the same unused days.
    creditBasisPeriodEnd: priced.credit > 0 ? subscription?.currentPeriodEnd || null : null,
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
    // Stated rather than implied: the client picks its checkout mode from this plus which id is set.
    autopay: false,
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

/**
 * The same checkout payload again for an order that is already open. Identical shape to
 * createCheckout's — a resumed checkout must be indistinguishable to the client, which is what makes
 * a double tap harmless rather than merely reported.
 */
const resumeCheckout = ({ payment, plan, user, business }) => {
  const provider = getProvider(payment.provider);

  return {
    paymentId: String(payment._id),
    orderId: payment.providerRefs.orderId,
    autopay: false,
    amount: payment.netAmount,
    currency: payment.currency,
    provider: payment.provider,
    providerConfig: provider.publicConfig(),
    plan: { planId: String(plan._id), planKey: plan.key, name: plan.name },
    interval: payment.billingInterval,
    breakdown: {
      gross: payment.amount,
      discount: Math.max(0, payment.discount - (payment.proratedCredit || 0)),
      proratedCredit: payment.proratedCredit || 0,
      netAmount: payment.netAmount
    },
    couponCode: payment.couponCode || '',
    prefill: { name: user.name, email: user.email, contact: business.phone || '' },
    // So a client can tell the difference for analytics. Nothing branches on it.
    resumed: true
  };
};

// ---------------------------------------------------------------------------
// Autopay enrolment (recurring mandate)
// ---------------------------------------------------------------------------

/**
 * How many cycles a mandate is authorised for. Razorpay requires a finite count, and when it is
 * exhausted the subscription `completed`s and the customer falls back to manual renewal reminders
 * automatically (no access is lost).
 *
 * ponytail: fixed horizons rather than a re-enrol job. 10 years is longer than the product has
 * existed; if a mandate ever actually completes, that notification is the feature.
 */
const AUTOPAY_TOTAL_COUNT = { month: 120, year: 10 };

// A mandate in any of these is already spoken for; a second enrolment must not silently mint another.
const AUTOPAY_LIVE_STATUSES = ['pending', 'authenticated', 'active'];

/**
 * Cache key for a provider-side plan, fingerprinting everything the provider baked into it.
 *
 * The AMOUNT is part of the key because a Razorpay plan is immutable: change the price and you need
 * a different plan, so a key that ignored the amount would hand new customers a mandate at the old
 * price. Colons only — a `.` would be read as a path separator by the `$set` that stores this.
 */
const providerPlanKey = (providerName, price) =>
  [providerName, price.interval, price.intervalCount || 1, price.currency || CURRENCY, price.amount].join(':');

/**
 * The provider's plan id for this exact price, minting it once and caching it on the Plan.
 *
 * Deliberately no invalidation: an old fingerprint stays in the map because mandates already running
 * still reference that provider plan, and the provider owns that link. An admin price change simply
 * misses the cache and mints a new one.
 *
 * ponytail: two instances racing a cache miss mint two provider plans and the last write wins. The
 * orphan is inert (a provider plan is only reachable through a subscription that names it), so this
 * is cheaper than a lock.
 */
const ensureProviderPlanId = async ({ provider, plan, price, cacheKey }) => {
  const cached = plan.prices.find((row) => row.interval === price.interval)?.providerRefs?.get(cacheKey);
  if (cached) return cached;

  const { providerPlanId } = await provider.ensureProviderPlan({
    name: `${plan.name} (${price.interval}ly)`,
    amount: price.amount,
    currency: price.currency || CURRENCY,
    interval: price.interval,
    intervalCount: price.intervalCount || 1
  });

  await Plan.updateOne(
    { _id: plan._id, 'prices.interval': price.interval },
    { $set: { [`prices.$.providerRefs.${cacheKey}`]: providerPlanId } }
  );

  return providerPlanId;
};

/**
 * The enrolment payload. Same shape as a one-time checkout so the client opens the provider's sheet
 * through one branch: `subscriptionId` instead of `orderId`, everything else identical.
 */
const autopayCheckoutPayload = ({ subscription, plan, priced, user, business, provider, resumed = false }) => ({
  // No payment row exists yet — see createAutopayEnrolment.
  paymentId: '',
  orderId: '',
  subscriptionId: subscription.provider.subscriptionId,
  autopay: true,
  amount: subscription.autopay.chargeAmount,
  currency: subscription.autopay.currency,
  provider: provider.name,
  providerConfig: provider.publicConfig(),
  plan: { planId: String(plan._id), planKey: plan.key, name: plan.name },
  interval: subscription.autopay.interval,
  // List price by construction: autopay refuses coupons and proration, so there is nothing to itemise.
  breakdown: { gross: priced.gross, discount: 0, proratedCredit: 0, netAmount: subscription.autopay.chargeAmount },
  couponCode: '',
  prefill: { name: user.name, email: user.email, contact: business.phone || '' },
  ...(resumed ? { resumed: true } : {})
});

/**
 * Sets up a recurring mandate instead of taking a single payment.
 *
 * **No `SubscriptionPayment` row is created here, on purpose.** A `created` row with no order id
 * would burn a receipt number on a mandate that may never be authenticated, and would force every
 * consumer of that collection (openCheckoutFor, listPayments, the reconciliation scan) to learn
 * about amount-less rows. Instead every cycle row — including the first — is created from its own
 * charge event, so cycle 1 and cycle 60 are one code path. That is the whole reason for using the
 * provider's recurring API rather than scheduling debits here.
 *
 * List price only. Coupons and proration credits stay on the one-time path: a discount that applied
 * for one cycle of a mandate is a different (and much more failure-prone) product promise, and a
 * proration credit priced into a recurring charge would repeat forever.
 */
const createAutopayEnrolment = async ({ user, business, plan, interval, couponCode, providerName, now }) => {
  // Capability first: refusing before any state is touched keeps a mis-typed provider harmless.
  const provider = getAutopayProvider(providerName);

  if (couponCode) {
    throw new ApiError(422, 'Discount codes apply to one-time payments. Pay manually to use this code.', {
      code: 'AUTOPAY_NO_COUPON',
      couponCode
    });
  }

  const totalCount = AUTOPAY_TOTAL_COUNT[interval];
  if (!totalCount) {
    throw new ApiError(400, 'Automatic payments are not available for that billing period', {
      code: 'AUTOPAY_INTERVAL_UNSUPPORTED',
      interval
    });
  }

  // Reuse the one pricer rather than reading plan.priceFor beside it — a second price derivation is
  // how a checkout and a charge end up disagreeing.
  const priced = await quote({ business, plan, interval, couponCode: '', now });
  if (priced.credit > 0) {
    throw new ApiError(422, 'You have unused time on your current plan. Pay manually to use that credit, then turn autopay on.', {
      code: 'AUTOPAY_NO_PRORATION',
      proratedCredit: priced.credit
    });
  }
  if (priced.netAmount <= 0) {
    throw new ApiError(422, 'There is nothing to pay for this plan. Contact support to have it applied.', {
      code: 'NOTHING_TO_CHARGE',
      netAmount: priced.netAmount
    });
  }

  const price = plan.priceFor(interval);
  // ensureSubscription is idempotent, and the mandate mirror has to live somewhere even for a
  // business that has never had a subscription row.
  const subscription = (await getSubscription(business._id)) || (await ensureSubscription({ business }));

  if (subscription.provider?.subscriptionId && AUTOPAY_LIVE_STATUSES.includes(subscription.autopay?.status)) {
    const sameTerms = subscription.autopay.planKey === plan.key && subscription.autopay.interval === interval;

    if (subscription.autopay.status === 'active') {
      throw new ApiError(409, 'Autopay is already set up for this plan.', {
        code: 'AUTOPAY_ALREADY_ACTIVE',
        planKey: subscription.autopay.planKey,
        interval: subscription.autopay.interval
      });
    }
    if (!sameTerms) {
      throw new ApiError(409, 'You have an autopay setup waiting to be approved. Finish or cancel it before changing plans.', {
        code: 'AUTOPAY_ALREADY_PENDING',
        planKey: subscription.autopay.planKey,
        interval: subscription.autopay.interval
      });
    }
    // Same terms, still unapproved: hand back the mandate we already minted. The server-side half of
    // idempotency, exactly as resumeCheckout is for orders.
    return autopayCheckoutPayload({ subscription, plan, priced, user, business, provider, resumed: true });
  }

  const cacheKey = providerPlanKey(provider.name, price);
  const providerPlanId = await ensureProviderPlanId({ provider, plan, price, cacheKey });

  const created = await provider.createSubscription({
    providerPlanId,
    totalCount,
    // Same role as an order's notes: they come back on every event, so a charge can be matched to a
    // business even if our own lookup by subscription id ever fails.
    notes: {
      billjiSubscriptionId: String(subscription._id),
      businessId: String(business._id),
      planId: String(plan._id),
      interval
    }
  });

  subscription.provider.name = provider.name;
  subscription.provider.subscriptionId = created.providerSubscriptionId;
  if (created.customerId) subscription.provider.customerId = created.customerId;

  // enabled stays FALSE: the customer has not approved anything yet. Only
  // `subscription.authenticated` may flip it, and even that grants no access.
  subscription.autopay.enabled = false;
  subscription.autopay.status = 'pending';
  subscription.autopay.planKey = plan.key;
  subscription.autopay.interval = interval;
  // The pre-agreed amount, written BEFORE any debit exists. Every recurring charge is checked
  // against this and nothing else.
  subscription.autopay.chargeAmount = priced.netAmount;
  subscription.autopay.currency = priced.currency;
  subscription.autopay.providerPlanKey = cacheKey;
  subscription.autopay.failureCount = 0;
  subscription.autopay.cancelledAt = null;
  await subscription.save();

  return autopayCheckoutPayload({ subscription, plan, priced, user, business, provider });
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

  return applyCapturedPayment({ claimed, actor, now });
};

/**
 * Turns an already-`captured` payment into an active subscription.
 *
 * Split out of activateFromPayment for one reason: the claim above and the writes below are separate
 * operations, so a restart in between leaves money captured with no subscription — and every retry
 * then hits the `!claimed` branch and cheerfully reports success. billingReconciliation calls this
 * to finish those rows. Nothing here re-claims, so it is safe to call on a captured row and only on
 * a captured row.
 */
export const applyCapturedPayment = async ({ claimed, actor = { type: 'system' }, now = new Date() }) => {
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

  // The unused days this payment was discounted for are no longer the days the subscription holds:
  // another checkout activated in between and consumed the same credit. Money has already moved, so
  // this cannot be refused — it is flagged for ops. Prevention lives at checkout
  // (CHECKOUT_ALREADY_OPEN); this is the detector for whatever slips through the window.
  if (claimed.proratedCredit > 0 && claimed.creditBasisPeriodEnd) {
    const stillTheSamePeriod = existing?.currentPeriodEnd?.getTime() === claimed.creditBasisPeriodEnd.getTime();
    if (!stillTheSamePeriod) {
      console.error(`[billing] stale proration credit on payment ${claimed._id}: the credited period has already changed`);
      void logAudit(null, {
        business: claimed.business,
        action: 'billing.proration.credit_stale',
        resourceType: 'subscription',
        metadata: {
          paymentId: String(claimed._id),
          credit: claimed.proratedCredit,
          creditBasisPeriodEnd: claimed.creditBasisPeriodEnd,
          currentPeriodEnd: existing?.currentPeriodEnd || null
        }
      });
    }
  }

  const isRenewal = existing && String(existing.plan) === String(plan._id);
  const bonusDays = claimed.couponCode ? await bonusDaysForCoupon(claimed.couponCode) : 0;

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

  // A free-period / trial-extension coupon buys time. Granted through the reward engine rather than by
  // mutating the period here: free time is a reward, and the engine is the only thing allowed to hand
  // one out. That buys three things this code never had — a RewardGrant ledger row, an idempotency lock
  // (so a reconciliation replay cannot extend the period twice) and a reversal path on refund.
  if (bonusDays > 0) {
    const owner = await Business.findById(claimed.business).select('owner');
    if (owner?.owner) {
      await grantReward({
        rule: 'coupon_time',
        dedupeKey: String(claimed._id),
        beneficiary: owner.owner,
        business: claimed.business,
        // The plan they actually bought, not a fixed one: a free_period coupon on Business must extend
        // Business.
        effect: { planKey: plan.key, days: bonusDays },
        source: { payment: claimed._id, note: `Coupon ${claimed.couponCode}` },
        actor,
        now
      }).catch((error) => console.error('[billing] coupon time grant failed:', error.message));
    }
  }

  claimed.subscription = subscription._id;
  claimed.periodStart = subscription.currentPeriodStart;
  claimed.periodEnd = subscription.currentPeriodEnd;
  await claimed.save();

  // `alreadyRedeemed` matters on the recovery path: a crash between the redemption and the payment's
  // own save must not claim a second slot when reconciliation finishes the row.
  const alreadyRedeemed = claimed.couponCode ? await CouponRedemption.exists({ payment: claimed._id }) : null;

  if (claimed.couponCode && !alreadyRedeemed) {
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

  // Reward Rule 2: the first paid subscription by a referred business pays their referrer a free month.
  //
  // Hooked HERE and nowhere else, because this is the single point every real payment reaches — client
  // verify, webhook, autopay cycle and the reconciliation job all funnel through it, so a referral
  // cannot be converted twice and cannot be missed. Non-fatal on purpose: a reward that fails must
  // never fail the activation of a subscription somebody just paid for.
  // Awaited, but its failure is swallowed: the caller must not see a 500 because a reward could not be
  // granted, and the referrer's month must be in place before the response says the payment is done —
  // a fire-and-forget here would make "did my referral pay out?" a race with the next request.
  await onPaidSubscription({ payment: claimed, now }).catch((error) =>
    console.error('[referrals] conversion reward failed after payment:', error.message)
  );

  return { payment: claimed, subscription, alreadyApplied: false };
};

// Read the row directly: applicability was already decided when the price was quoted, and the
// customer has since paid that price.
const bonusDaysForCoupon = async (code) => Math.round(timeGrant(await Coupon.findOne({ code })) / DAY_MS);

/**
 * Does a provider-reported amount match what this payment is for?
 *
 * `null`/`undefined` means the provider did not tell us (some webhook payloads carry no amount), and
 * silence is not a mismatch. Shared by the client verify path and the webhook so the two cannot
 * disagree about what counts as the right amount.
 */
export const amountMatchesPayment = (payment, amount) =>
  amount === null || amount === undefined ? true : asPaise(amount) === payment.netAmount;

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
  if (!amountMatchesPayment(payment, remote.amount)) {
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

// ---------------------------------------------------------------------------
// Stopping a mandate
// ---------------------------------------------------------------------------

/**
 * Cancels the mandate at the provider and mirrors that locally.
 *
 * `atCycleEnd` by default, which matches what BillJi's own cancellation does: the customer keeps the
 * period they already paid for, and no further debit is attempted.
 *
 * Throws if the provider cannot confirm the mandate is stopped. That is the whole point — see
 * cancelWithProvider.
 */
export const stopMandate = async ({ subscription, atCycleEnd = true, now = new Date() }) => {
  const providerSubscriptionId = subscription.provider?.subscriptionId;
  if (!providerSubscriptionId) return { stopped: false };

  const provider = getProvider(subscription.provider?.name || undefined);

  try {
    await provider.cancelProviderSubscription({ providerSubscriptionId, atCycleEnd });
  } catch (error) {
    // The mandate may already be cancelled/completed, in which case the outcome we wanted is the
    // outcome that holds. Confirm that by READING the mandate rather than pattern-matching the
    // provider's error text, which is not a contract.
    const remote = await provider.fetchSubscription(providerSubscriptionId).catch(() => null);
    if (!['cancelled', 'completed', 'expired'].includes(remote?.status)) throw error;
  }

  await Subscription.updateOne(
    { _id: subscription._id },
    {
      $set: {
        'autopay.enabled': false,
        'autopay.status': 'cancelled',
        'autopay.cancelledAt': now,
        'autopay.nextDebitAt': null
      }
    }
  );

  return { stopped: true };
};

/**
 * Cancel the subscription, mandate included.
 *
 * THE MANDATE GOES FIRST, AND STRICTLY. If the provider will not confirm the mandate is stopped,
 * nothing is cancelled locally: a BillJi-cancelled subscription with a live mandate keeps debiting a
 * customer who cancelled, which is the worst outcome this feature can produce. Better to surface an
 * error the customer can retry.
 *
 * Lives here rather than in subscriptionService because that module imports no provider and must keep
 * it that way — and rather than in the controller, because the refund path would then miss it.
 */
export const cancelWithProvider = async ({ business, reason = '', immediate = false, actor = { type: 'system' }, now = new Date() }) => {
  const businessId = business._id || business;
  const subscription = await getSubscription(businessId);

  if (subscription && AUTOPAY_LIVE_STATUSES.includes(subscription.autopay?.status)) {
    await stopMandate({ subscription, atCycleEnd: true, now });
  }

  return cancelSubscription({ business: businessId, reason, immediate, actor, now });
};

/**
 * Turns autopay off and changes nothing else.
 *
 * Not a cancellation: the period, the plan and `cancel.*` are all left alone, so the customer keeps
 * what they paid for and simply goes back to approving each renewal. The existing manual renewal
 * reminders resume by themselves, because they skip only mandates that are `active`.
 *
 * Idempotent — turning off an already-off mandate is a no-op, not an error.
 */
export const disableAutopay = async ({ business, now = new Date() }) => {
  const businessId = business._id || business;
  const subscription = await getSubscription(businessId);

  if (!subscription) {
    throw new ApiError(404, 'There is no subscription on this business', { code: 'SUBSCRIPTION_NOT_FOUND' });
  }
  if (!AUTOPAY_LIVE_STATUSES.includes(subscription.autopay?.status)) {
    return { subscription, changed: false };
  }

  await stopMandate({ subscription, atCycleEnd: true, now });
  return { subscription: await getSubscription(businessId), changed: true };
};

/**
 * Writes a refund's consequences. Shared by the admin-initiated path and the provider webhook (a
 * refund issued from the Razorpay dashboard arrives only as an event).
 *
 * Idempotency is keyed on the REFUND id, not the webhook event id. Razorpay sends both
 * `refund.created` and `refund.processed` for one refund, with two different event ids, so an
 * event-keyed guard let a single ₹500 refund be recorded as ₹1000 — and two half-refunds then
 * summed to the full amount, flipping the payment to `refunded` and cancelling a subscription the
 * customer had only partly been refunded for. The event id is still recorded, for the trail.
 *
 * The arithmetic runs as an aggregation-pipeline update so the total is computed from the stored
 * value inside the same atomic operation. Reading `refundedAmount` into JS first and writing back a
 * sum is the shape that produced the double-count.
 */
/**
 * Reverses the free days a coupon on this payment granted. Keyed on the payment id, which is the
 * dedupeKey the grant was written with, so it finds exactly one grant or none.
 */
const reverseCouponTimeForPayment = async ({ payment, actor, now }) => {
  const owner = await Business.findById(payment.business).select('owner');
  if (!owner?.owner) return null;

  const grants = await listGrantsFor({ beneficiary: owner.owner, rule: 'coupon_time', limit: 20 });
  const target = grants.find(
    (candidate) => String(candidate.dedupeKey) === String(payment._id) && candidate.status === 'granted'
  );
  if (!target) return null;

  return reverseReward({ grant: target, reason: `Refunded payment ${payment._id}`, actor, now });
};

export const applyRefund = async ({ payment, refundId = '', amount, eventId = '', actor = { type: 'system' }, now = new Date() }) => {
  const requested = asPaise(amount);
  // A refund with no provider id (a manual reversal recorded by hand) falls back to the event id,
  // and finally to a value that cannot collide — never to "no guard at all".
  const refundKey = refundId || eventId || `local:${now.getTime()}`;

  const updated = await SubscriptionPayment.findOneAndUpdate(
    { _id: payment._id, refundIds: { $ne: refundKey } },
    [
      {
        $set: {
          refundedAmount: { $min: [{ $add: [{ $ifNull: ['$refundedAmount', 0] }, requested] }, '$netAmount'] },
          refundedAt: now,
          refundIds: { $setUnion: [{ $ifNull: ['$refundIds', []] }, [refundKey]] },
          ...(eventId ? { webhookEventIds: { $setUnion: [{ $ifNull: ['$webhookEventIds', []] }, [eventId]] } } : {}),
          ...(refundId ? { 'providerRefs.refundId': refundId } : {})
        }
      },
      // Second stage so the status is decided from the total this update just wrote.
      { $set: { status: { $cond: [{ $gte: ['$refundedAmount', '$netAmount'] }, 'refunded', 'partially_refunded'] } } }
    ],
    { new: true }
  );

  // No match means this refund was already applied — by its other lifecycle event, by a redelivery,
  // or by the admin path that preceded the webhook.
  if (!updated) return { payment: await SubscriptionPayment.findById(payment._id), alreadyApplied: true };

  if (updated.status === 'refunded') {
    // Give the redemption slot back — a fully refunded purchase did not consume the coupon.
    if (payment.couponCode) {
      const coupon = await Coupon.findOne({ code: payment.couponCode });
      if (coupon) await releaseCoupon({ coupon, business: payment.business, payment: payment._id }).catch(() => {});
    }

    // Take back every reward this payment produced.
    //
    // Two directions, and they are different rewards on different accounts: free days this payment's
    // own coupon added to THIS business, and the free month it earned the REFERRER of this business.
    // Leaving either in place turns pay-then-refund into a free month generator.
    await reverseCouponTimeForPayment({ payment, actor, now }).catch((error) =>
      console.error('[billing] could not reverse coupon time after refund:', error.message)
    );
    await reverseRewardForPayment({ payment, actor, now }).catch((error) =>
      console.error('[referrals] could not reverse the referrer reward after refund:', error.message)
    );

    const subscription = await getSubscription(payment.business);
    // Only end the period this payment actually bought. A refund of an old payment must not revoke
    // a later one the customer has already paid for.
    if (subscription && payment.periodEnd && subscription.currentPeriodEnd?.getTime() === payment.periodEnd.getTime()) {
      // cancelWithProvider, not cancelSubscription: refunding the current cycle of an autopay
      // subscription must also stop the mandate, or we debit again next month a customer we just
      // refunded. Both refund entry points (webhook and refundPayment) route through here.
      await cancelWithProvider({
        business: subscription.business,
        reason: `Refunded payment ${payment._id}`,
        immediate: true,
        actor,
        now
      }).catch((error) => {
        // Already cancelled or already expired: the outcome this refund wanted is the outcome that
        // holds, so it is a success. Throwing here made the webhook answer 500 and Razorpay retry a
        // settled refund for hours.
        if (!['SUBSCRIPTION_ALREADY_CANCELLED', 'SUBSCRIPTION_NOT_FOUND'].includes(error?.details?.code)) throw error;
      });
    }
  }

  return { payment: updated, alreadyApplied: false };
};

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export const RECEIPT_PREFIX = 'BILLJI';
export const RECEIPT_SEQUENCE_TYPE = 'billji_receipt';

/**
 * Sequential receipt number, e.g. BILLJI/2026-27/000123.
 *
 * Allocated through NumberSequence — the same guarded `$inc` every other series in this codebase
 * uses. The read-max-then-add-1 this replaced was a real race: two concurrent checkouts both read
 * the same maximum and both received BILLJI/2026-27/000001.
 *
 * A NUMBER only. This is deliberately NOT a GST tax invoice: issuing one needs BillJi's own GSTIN,
 * the SAC code for the service, and a place-of-supply rule to pick IGST vs CGST+SGST from the
 * customer's state — all product/compliance decisions, not engineering ones. The number is
 * allocated now so the sequence is continuous from the first rupee; the document waits for those
 * answers (see docs §14.6).
 */
export const nextReceiptNumber = async (now = new Date()) => {
  const { sequence, financialYear } = await nextPlatformSequence({
    documentType: RECEIPT_SEQUENCE_TYPE,
    prefix: RECEIPT_PREFIX,
    date: now
  });

  return `${RECEIPT_PREFIX}/${financialYear}/${String(sequence).padStart(6, '0')}`;
};

// Abandoned checkouts are noise in a customer-facing history.
export const listPayments = ({ business, limit = 50, skip = 0 }) =>
  SubscriptionPayment.find({ business: business._id || business, status: { $ne: 'created' } })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
