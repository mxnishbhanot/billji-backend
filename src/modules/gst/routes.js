import { Router } from 'express';
import { getGstr1, getGstr3b, returnQueryRules } from './controller.js';
import { FEATURES } from '../../constants/entitlements.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { requireFeature } from '../../middlewares/entitlement.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

// A GST return is the month's sales in filing form — same sensitivity as reports, so it
// reuses reports.view rather than inventing a permission nobody has been granted yet.
router.use(protect);
router.use(requirePermission(PERMISSIONS.reportsView));
// GSTR-1 / GSTR-3B are the advanced GST reports in the plan catalog — billing GST invoices
// (gst_billing, on every plan) is a different thing from filing them.
router.use(requireFeature(FEATURES.advancedGstReports));

router.get('/gstr1', returnQueryRules, validate, getGstr1);
router.get('/gstr3b', returnQueryRules, validate, getGstr3b);

export default router;
