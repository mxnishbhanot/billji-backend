import { Router } from 'express';
import { getSettings, invoiceTemplatePreview, settingsRules, updateSettings } from '../controllers/settingsController.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.settingsView, PERMISSIONS.settingsManage), getSettings);
router.patch('/', requirePermission(PERMISSIONS.settingsManage), settingsRules, validate, updateSettings);
router.post('/invoice-template/preview', requirePermission(PERMISSIONS.settingsView, PERMISSIONS.settingsManage), invoiceTemplatePreview);

export default router;
