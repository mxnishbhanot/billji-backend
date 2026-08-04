import { Router } from 'express';
import {
  applyReferral,
  getEligibility,
  getMyReferral,
  getMyReferrals,
  getMyRewards,
  getMyStats
} from './controller.js';
import { applyReferralRules, listRules } from './schema.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);

// Reads are billing-grade reads: the same people who may see the plan may see the referral screen.
const canView = requirePermission(PERMISSIONS.billingView, PERMISSIONS.billingManage, PERMISSIONS.settingsManage);
// Applying a code grants a paid plan. Same permission as buying one, because it is the same decision
// about the workspace's subscription.
const canManage = requirePermission(PERMISSIONS.billingManage);

router.get('/me', canView, getMyReferral);
router.get('/me/stats', canView, getMyStats);
router.get('/me/rewards', canView, listRules, validate, getMyRewards);
router.get('/me/referrals', canView, listRules, validate, getMyReferrals);
router.get('/me/eligibility', canView, getEligibility);

// Idempotent for the same reason checkout is: a double tap, or a retry over a flaky connection, must
// replay the first answer rather than racing itself. The offline push path wraps the same handler in
// the same middleware, keyed on the outbox op id.
router.post('/apply', canManage, applyReferralRules, validate, idempotency(), applyReferral);

export default router;
