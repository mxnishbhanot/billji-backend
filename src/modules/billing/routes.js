import { Router } from 'express';
import {
  beginTrial,
  cancel,
  cancelRules,
  checkoutRules,
  confirmCheckout,
  couponRules,
  getPayments,
  paymentQueryRules,
  previewCoupon,
  reactivate,
  startCheckout,
  trialRules,
  turnOffAutopay,
  verifyRules
} from './checkoutController.js';
import { getPlans, getSubscription, getUsage } from './controller.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requireBillingOwner, requirePermission } from '../../middlewares/authorization.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);

// Every route below is exactly one of three classes, and the class decides the guards:
//
//   Read-only       permission only. Nothing changes, nothing is charged.
//   Administrative  permission only. State may be computed but never committed, and no money moves.
//   Money-changing  permission AND requireBillingOwner. Binds the business to a charge, a refund,
//                   a mandate, or the loss of service.
//
// Only the third class gets the ownership guard, and it goes AFTER the permission guard so the 403
// stays specific: a staff member gets FORBIDDEN_PERMISSION, an admin gets FORBIDDEN_OWNER_ONLY, and
// the client can tell "you can't see this" apart from "ask the owner".

// Reads are settings-grade: a manager should be able to see what plan constrains their work.
const canView = requirePermission(PERMISSIONS.billingView, PERMISSIONS.billingManage, PERMISSIONS.settingsManage);
// Narrower than canView. Invoices and payment history are financial records — the accountant's job,
// not the viewer's.
const canInvoices = requirePermission(PERMISSIONS.billingInvoices, PERMISSIONS.billingManage);
// Separate from settings.manage, because editing an invoice template and buying a year of Business
// are not the same trust level. Paired with requireBillingOwner on every route that uses them —
// the permission decides visibility, ownership decides the spend.
const canChangePlan = requirePermission(PERMISSIONS.billingSubscriptionChange, PERMISSIONS.billingManage);
const canPaymentMethod = requirePermission(PERMISSIONS.billingPaymentMethod, PERMISSIONS.billingManage);

// --- Read-only ---------------------------------------------------------------------------------
router.get('/plans', canView, getPlans);
router.get('/subscription', canView, getSubscription);
router.get('/usage', canView, getUsage);
router.get('/payments', canInvoices, paymentQueryRules, validate, getPayments);

// --- Administrative ----------------------------------------------------------------------------
// A quote, not a purchase: no state change and no charge. Deliberately NOT owner-gated so a manager
// can price an upgrade and put the case to the owner.
router.post('/coupons/preview', canView, couponRules, validate, previewCoupon);

// --- Money-changing ----------------------------------------------------------------------------
// Idempotent: a double tap on "Upgrade" (or a retry over a flaky mobile connection) must replay the
// first order, not open a second one the customer could pay twice.
router.post('/checkout', canChangePlan, requireBillingOwner, checkoutRules, validate, idempotency(), startCheckout);
router.post('/checkout/verify', canChangePlan, requireBillingOwner, verifyRules, validate, confirmCheckout);
// Owner-gated despite costing nothing today: it burns the one-shot trial.used latch for the whole
// business, and it opens a paid relationship.
router.post('/trial', canChangePlan, requireBillingOwner, trialRules, validate, beginTrial);
router.post('/cancel', canChangePlan, requireBillingOwner, cancelRules, validate, cancel);
router.post('/reactivate', canChangePlan, requireBillingOwner, reactivate);
// Stops the mandate without ending the subscription. No body, and no idempotency wrapper: turning
// autopay off twice is naturally a no-op. Owner-gated — revoking a bank mandate is the same money
// decision as granting one.
router.post('/autopay/off', canPaymentMethod, requireBillingOwner, turnOffAutopay);

export default router;
