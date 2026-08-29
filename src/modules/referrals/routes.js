import { Router } from 'express';
import {
  apply,
  applyReferralRules,
  myEligibility,
  myReferral,
  myReferrals,
  myRewards,
  myStats,
  pageRules
} from './controller.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);

// Reads sit behind billing.view — a referral is plan time, so whoever may see the plan may see
// what has been earned towards it. Deliberately not a paid feature: the programme that sells the
// paid plans cannot be locked behind them.
const canView = requirePermission(PERMISSIONS.billingView);

router.get('/me', canView, myReferral);
router.get('/me/stats', canView, myStats);
router.get('/me/rewards', canView, pageRules, validate, myRewards);
router.get('/me/referrals', canView, pageRules, validate, myReferrals);
router.get('/me/eligibility', canView, myEligibility);

// Applying a code changes the plan, so it takes the permission that buying one does. The
// Idempotency-Key the client sends is its outbox operation id: a retry replays the first answer.
router.post(
  '/apply',
  requirePermission(PERMISSIONS.billingSubscriptionChange),
  applyReferralRules,
  validate,
  idempotency(),
  apply
);

export default router;
