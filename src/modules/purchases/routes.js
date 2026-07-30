import { Router } from 'express';
import {
  cancelPurchase,
  createPurchase,
  createVendor,
  getPurchase,
  getVendorOutstanding,
  listPurchases,
  listVendors,
  purchaseQueryRules,
  purchaseRules,
  recalculateVendorPayable,
  recordVendorPayment,
  updateVendor,
  vendorPaymentRules,
  vendorRules
} from './controller.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);

// Vendors are only meaningful alongside purchases, so they share the same permissions
// and live under the same router rather than getting a top-level resource of their own.
router.get('/vendors', requirePermission(PERMISSIONS.purchasesView), listVendors);
router.post('/vendors', requirePermission(PERMISSIONS.purchasesManage), vendorRules, validate, createVendor);
router.patch('/vendors/:id', requirePermission(PERMISSIONS.purchasesManage), vendorRules, validate, updateVendor);
router.get('/vendors/:id/outstanding', requirePermission(PERMISSIONS.purchasesView), getVendorOutstanding);
router.post(
  '/vendors/:id/payments',
  requirePermission(PERMISSIONS.purchasesManage),
  vendorPaymentRules,
  validate,
  idempotency(),
  recordVendorPayment
);
router.post('/vendors/:id/recalculate', requirePermission(PERMISSIONS.purchasesManage), recalculateVendorPayable);

router.get('/', requirePermission(PERMISSIONS.purchasesView), purchaseQueryRules, validate, listPurchases);
router.post('/', requirePermission(PERMISSIONS.purchasesManage), purchaseRules, validate, idempotency(), createPurchase);
router.get('/:id', requirePermission(PERMISSIONS.purchasesView), getPurchase);
router.post('/:id/cancel', requirePermission(PERMISSIONS.purchasesManage), cancelPurchase);

export default router;
