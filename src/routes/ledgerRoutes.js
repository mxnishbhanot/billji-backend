import { Router } from 'express';
import { ledgerQueryRules, listLedgerEntries } from '../controllers/ledgerController.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.reportsView), ledgerQueryRules, validate, listLedgerEntries);

export default router;
