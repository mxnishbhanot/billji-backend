import { Router } from 'express';
import { reportQueryRules, summary } from '../controllers/reportController.js';
import { FEATURES } from '../constants/entitlements.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { requireFeature } from '../middlewares/entitlement.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
// The dashboard summary is `basic_reports`, which every plan grants — the guard is here so the
// feature key is declared at the route rather than assumed, and so an advanced report added to
// this router has an obvious place to say so.
router.get('/summary', requirePermission(PERMISSIONS.reportsView), requireFeature(FEATURES.basicReports), reportQueryRules, validate, summary);

export default router;
