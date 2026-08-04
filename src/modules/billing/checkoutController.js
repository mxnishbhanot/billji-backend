import { body, param, query } from 'express-validator';
import Plan from '../../models/Plan.js';
import { BILLING_INTERVALS } from '../../constants/entitlements.js';
import { paymentDto } from '../../contracts/billingDto.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logAudit } from '../../services/auditService.js';
import { confirmAutopayMandate } from '../../services/autopayService.js';
import { cancelWithProvider, createCheckout, disableAutopay, listPayments, quote, verifyCheckout } from '../../services/billingService.js';
import { findApplicableCoupon } from '../../services/couponService.js';
import { availableProviders } from '../../services/payments/index.js';
import { reactivateSubscription, startTrial } from '../../services/subscriptionService.js';
import { currentSubscription } from './service.js';

// Only intervals a customer can actually buy. 'free' and 'lifetime' are not purchasable — a free
// plan needs no payment and a lifetime grant is an admin action.
const PURCHASABLE_INTERVALS = BILLING_INTERVALS.filter((interval) => ['month', 'year'].includes(interval));

const planSelector = [
  body('planId').optional().isMongoId(),
  body('planKey').optional().trim().isLength({ min: 1, max: 60 }),
  body().custom((value) => {
    if (!value.planId && !value.planKey) throw new Error('planId or planKey is required');
    return true;
  })
];

export const checkoutRules = [
  ...planSelector,
  body('interval').isIn(PURCHASABLE_INTERVALS).withMessage('interval must be month or year'),
  body('couponCode').optional({ checkFalsy: true }).trim().isLength({ max: 40 }),
  body('provider').optional({ checkFalsy: true }).isIn(availableProviders().length ? availableProviders() : ['razorpay', 'manual']),
  // Set up a recurring mandate instead of taking one payment. Absent reads as false, so every
  // existing client keeps buying exactly as it does today.
  body('autopay').optional().isBoolean().toBoolean()
];

export const verifyRules = [
  // Exactly one correlating id: `orderId` for a one-time payment, `subscriptionId` for a mandate
  // approval. They are verified with different HMACs (see razorpayProvider), so accepting both at
  // once would mean guessing which signature scheme the caller meant.
  body('orderId').optional({ checkFalsy: true }).trim().isLength({ max: 160 }),
  body('subscriptionId').optional({ checkFalsy: true }).trim().isLength({ max: 160 }),
  body().custom((value) => {
    if (!value.orderId && !value.subscriptionId) throw new Error('orderId or subscriptionId is required');
    if (value.orderId && value.subscriptionId) throw new Error('send either orderId or subscriptionId, not both');
    return true;
  }),
  body('paymentId').trim().notEmpty().withMessage('paymentId is required').isLength({ max: 160 }),
  body('signature').trim().notEmpty().withMessage('signature is required').isLength({ max: 500 })
];

export const couponRules = [
  body('code').trim().notEmpty().withMessage('code is required').isLength({ max: 40 }),
  ...planSelector,
  body('interval').isIn(PURCHASABLE_INTERVALS)
];

export const cancelRules = [
  body('reason').optional({ nullable: true }).trim().isLength({ max: 500 }),
  // Ending access before the paid period is over is a support action, not a self-serve one.
  body('immediate').not().exists().withMessage('immediate cancellation is not available')
];

export const paymentQueryRules = [query('limit').optional().isInt({ min: 1, max: 100 }), query('skip').optional().isInt({ min: 0 })];

export const trialRules = planSelector;

export const receiptParamRules = [param('id').isMongoId()];

const findPlan = async ({ planId, planKey }) => {
  const plan = planId ? await Plan.findById(planId) : await Plan.findOne({ key: planKey });
  if (!plan) throw new ApiError(404, 'That plan does not exist', { code: 'PLAN_NOT_FOUND' });
  return plan;
};

/**
 * Opens a checkout. Wrapped in the existing idempotency middleware at the route, so a double tap
 * replays the first response instead of opening a second order.
 */
export const startCheckout = asyncHandler(async (req, res) => {
  const checkout = await createCheckout({
    user: req.user,
    business: req.business,
    planId: req.body.planId || null,
    planKey: req.body.planKey || null,
    interval: req.body.interval,
    couponCode: req.body.couponCode || '',
    provider: req.body.provider,
    autopay: Boolean(req.body.autopay)
  });

  void logAudit(req, {
    action: checkout.autopay ? 'billing.autopay.enrolment_started' : 'billing.checkout_started',
    resourceType: 'subscription',
    // An autopay enrolment has no payment row yet — the mandate is the thing that was created.
    resourceId: checkout.paymentId || checkout.subscriptionId || '',
    metadata: { planKey: checkout.plan.planKey, interval: checkout.interval, amount: checkout.amount, autopay: Boolean(checkout.autopay) }
  });

  res.status(201).json({ success: true, checkout });
});

/**
 * Client-side confirmation. The webhook is the authority; this exists so the UI can unlock
 * immediately instead of polling. Whichever lands first activates, and the other becomes a no-op.
 */
export const confirmCheckout = asyncHandler(async (req, res) => {
  // Which id arrived decides which instrument is being confirmed — and therefore which signature
  // scheme applies. The validator guarantees exactly one of them is present.
  const { payment, alreadyApplied } = req.body.subscriptionId
    ? await confirmAutopayMandate({
        business: req.business,
        subscriptionId: req.body.subscriptionId,
        paymentId: req.body.paymentId,
        signature: req.body.signature
      })
    : await verifyCheckout({
        business: req.business,
        orderId: req.body.orderId,
        paymentId: req.body.paymentId,
        signature: req.body.signature
      });

  if (payment && !alreadyApplied) {
    void logAudit(req, {
      action: 'billing.payment_captured',
      resourceType: 'subscription',
      resourceId: String(payment._id),
      metadata: { planKey: payment.planKey, amount: payment.netAmount, provider: payment.provider }
    });
  }

  res.json({
    success: true,
    // Null only on the autopay path, when the mandate is approved but the first debit has not landed
    // yet. That is a success — the plan activates on the charge event — so it must not be an error
    // the client shows as a failed payment.
    payment: payment ? paymentDto(payment) : null,
    subscription: await currentSubscription({ user: req.user, business: req.business })
  });
});

/** Dry run: prices a plan with a coupon and never writes anything. */
export const previewCoupon = asyncHandler(async (req, res) => {
  const plan = await findPlan(req.body);
  const priced = await quote({
    business: req.business,
    plan,
    interval: req.body.interval,
    couponCode: req.body.code
  });

  const { reason } = await findApplicableCoupon({
    code: req.body.code,
    planKey: plan.key,
    interval: req.body.interval,
    business: req.business._id
  });

  res.json({
    success: true,
    coupon: {
      code: String(req.body.code).trim().toUpperCase(),
      valid: priced.valid,
      reason: reason || null,
      gross: priced.gross,
      discount: priced.discount,
      proratedCredit: priced.credit,
      netAmount: priced.netAmount,
      currency: priced.currency,
      bonusDays: priced.bonusMs ? Math.round(priced.bonusMs / (24 * 60 * 60 * 1000)) : 0
    }
  });
});

export const beginTrial = asyncHandler(async (req, res) => {
  const plan = await findPlan(req.body);
  await startTrial({ business: req.business, plan, actor: { type: 'user', userId: req.user._id } });

  void logAudit(req, {
    action: 'billing.trial_started',
    resourceType: 'subscription',
    resourceId: String(req.business._id),
    metadata: { planKey: plan.key, days: plan.trial.days }
  });

  res.status(201).json({ success: true, subscription: await currentSubscription({ user: req.user, business: req.business }) });
});

export const cancel = asyncHandler(async (req, res) => {
  // cancelWithProvider, not cancelSubscription: a cancelled subscription whose mandate is still live
  // would keep debiting the customer who just cancelled. It stops the mandate first and refuses to
  // cancel locally if it cannot.
  await cancelWithProvider({
    business: req.business,
    reason: req.body.reason || '',
    actor: { type: 'user', userId: req.user._id }
  });

  void logAudit(req, {
    action: 'billing.subscription_cancelled',
    resourceType: 'subscription',
    resourceId: String(req.business._id),
    metadata: { reason: req.body.reason || '' }
  });

  res.json({ success: true, subscription: await currentSubscription({ user: req.user, business: req.business }) });
});

/**
 * Turn autopay off, keep the plan. Distinct from cancelling on purpose — "stop charging me
 * automatically" and "end my subscription" are different intentions and conflating them is how a
 * customer loses access they meant to keep.
 */
export const turnOffAutopay = asyncHandler(async (req, res) => {
  const { changed } = await disableAutopay({ business: req.business });

  if (changed) {
    void logAudit(req, {
      action: 'billing.autopay.disabled',
      resourceType: 'subscription',
      resourceId: String(req.business._id)
    });
  }

  res.json({ success: true, subscription: await currentSubscription({ user: req.user, business: req.business }) });
});

export const reactivate = asyncHandler(async (req, res) => {
  await reactivateSubscription({ business: req.business, actor: { type: 'user', userId: req.user._id } });

  void logAudit(req, { action: 'billing.subscription_reactivated', resourceType: 'subscription', resourceId: String(req.business._id) });

  res.json({ success: true, subscription: await currentSubscription({ user: req.user, business: req.business }) });
});

export const getPayments = asyncHandler(async (req, res) => {
  const payments = await listPayments({
    business: req.business,
    limit: Number(req.query.limit || 50),
    skip: Number(req.query.skip || 0)
  });

  res.json({ success: true, payments: payments.map(paymentDto) });
});
