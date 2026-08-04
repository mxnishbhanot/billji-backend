import { Router } from 'express';
import { auditQueryRules, listAuditLogs } from '../controllers/auditController.js';
import { FEATURES } from '../constants/entitlements.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { requireFeature } from '../middlewares/entitlement.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
// Writing audit rows never stops — the trail must stay complete regardless of plan. Only
// *reading* it is the paid feature.
router.get('/', requirePermission(PERMISSIONS.settingsManage), requireFeature(FEATURES.auditLogs), auditQueryRules, validate, listAuditLogs);

export default router;
