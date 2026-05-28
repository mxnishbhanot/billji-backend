import { Router } from 'express';
import { auditQueryRules, listAuditLogs } from '../controllers/auditController.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.settingsManage), auditQueryRules, validate, listAuditLogs);

export default router;
