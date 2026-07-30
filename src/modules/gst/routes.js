import { Router } from 'express';
import { getGstr1, getGstr3b, returnQueryRules } from './controller.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

// A GST return is the month's sales in filing form — same sensitivity as reports, so it
// reuses reports.view rather than inventing a permission nobody has been granted yet.
router.use(protect);
router.use(requirePermission(PERMISSIONS.reportsView));

router.get('/gstr1', returnQueryRules, validate, getGstr1);
router.get('/gstr3b', returnQueryRules, validate, getGstr3b);

export default router;
