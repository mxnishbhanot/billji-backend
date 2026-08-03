import { Router } from 'express';
import { getPlans, getSubscription, getUsage } from './controller.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';

const router = Router();

router.use(protect);

// Read-only in this phase. Guarded with settingsView because seeing which plan the business is on
// is settings-grade information, not privileged. The dedicated billing.view / billing.manage
// permission pair lands with checkout in Phase 3 — there is nothing to authorise separately until
// something can be changed or charged.
const canView = requirePermission(PERMISSIONS.settingsView, PERMISSIONS.settingsManage);

router.get('/plans', canView, getPlans);
router.get('/subscription', canView, getSubscription);
router.get('/usage', canView, getUsage);

export default router;
