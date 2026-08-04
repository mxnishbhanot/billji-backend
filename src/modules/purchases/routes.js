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
import { FEATURES } from '../../constants/entitlements.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { requireFeature } from '../../middlewares/entitlement.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);

// Vendors live under this router, so they are part of the purchases feature by construction.
// Permission first on every route, then plan — a 403 for who you are outranks a 402 for what the
// business bought.
const purchasesFeature = requireFeature(FEATURES.purchases);

// Vendors are only meaningful alongside purchases, so they share the same permissions
// and live under the same router rather than getting a top-level resource of their own.
router.get('/vendors', requirePermission(PERMISSIONS.purchasesView), purchasesFeature, listVendors);
router.post('/vendors', requirePermission(PERMISSIONS.purchasesManage), purchasesFeature, vendorRules, validate, createVendor);
router.patch('/vendors/:id', requirePermission(PERMISSIONS.purchasesManage), purchasesFeature, vendorRules, validate, updateVendor);
router.get('/vendors/:id/outstanding', requirePermission(PERMISSIONS.purchasesView), purchasesFeature, getVendorOutstanding);
router.post(
  '/vendors/:id/payments',
  requirePermission(PERMISSIONS.purchasesManage),
  purchasesFeature,
  vendorPaymentRules,
  validate,
  idempotency(),
  recordVendorPayment
);
router.post('/vendors/:id/recalculate', requirePermission(PERMISSIONS.purchasesManage), purchasesFeature, recalculateVendorPayable);

router.get('/', requirePermission(PERMISSIONS.purchasesView), purchasesFeature, purchaseQueryRules, validate, listPurchases);
router.post('/', requirePermission(PERMISSIONS.purchasesManage), purchasesFeature, purchaseRules, validate, idempotency(), createPurchase);
router.get('/:id', requirePermission(PERMISSIONS.purchasesView), purchasesFeature, getPurchase);
router.post('/:id/cancel', requirePermission(PERMISSIONS.purchasesManage), purchasesFeature, cancelPurchase);

export default router;
