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
  verifyRules
} from './checkoutController.js';
import { getPlans, getSubscription, getUsage } from './controller.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);

// Reads are settings-grade: an accountant should be able to pull an invoice.
const canView = requirePermission(PERMISSIONS.billingView, PERMISSIONS.billingManage, PERMISSIONS.settingsManage);
// Spending money is its own permission — separate from settings.manage, because editing an invoice
// template and buying a year of Business are not the same trust level.
const canManage = requirePermission(PERMISSIONS.billingManage);

router.get('/plans', canView, getPlans);
router.get('/subscription', canView, getSubscription);
router.get('/usage', canView, getUsage);
router.get('/payments', canView, paymentQueryRules, validate, getPayments);

// Idempotent: a double tap on "Upgrade" (or a retry over a flaky mobile connection) must replay the
// first order, not open a second one the customer could pay twice.
router.post('/checkout', canManage, checkoutRules, validate, idempotency(), startCheckout);
router.post('/checkout/verify', canManage, verifyRules, validate, confirmCheckout);
router.post('/coupons/preview', canView, couponRules, validate, previewCoupon);
router.post('/trial', canManage, trialRules, validate, beginTrial);
router.post('/cancel', canManage, cancelRules, validate, cancel);
router.post('/reactivate', canManage, reactivate);

export default router;
