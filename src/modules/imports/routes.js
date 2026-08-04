import { Router } from 'express';
import { importFields, importRules, previewImport, runImport } from './controller.js';
import { FEATURES } from '../../constants/entitlements.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { requireFeature } from '../../middlewares/entitlement.js';
import { validate } from '../../middlewares/validate.js';
import { IMPORT_ENTITIES } from './fields.js';

const router = Router();

router.use(protect);

// requirePermission is an OR across its arguments, so importing customers must not be let
// through by products.manage. Which permission applies depends on the body, so pick it here.
const requireImportPermission = (req, res, next) => {
  const permissionName = IMPORT_ENTITIES[req.body?.type]?.permission;
  if (!permissionName) return next();
  return requirePermission(PERMISSIONS[permissionName])(req, res, next);
};

router.get('/fields', requirePermission(PERMISSIONS.customersManage, PERMISSIONS.productsManage), importFields);
// Preview is gated too: it parses the customer's file and maps it, which is the feature.
router.post('/preview', importRules, validate, requireImportPermission, requireFeature(FEATURES.dataImport), previewImport);
router.post(
  '/commit',
  importRules,
  validate,
  requireImportPermission,
  requireFeature(FEATURES.dataImport),
  idempotency(),
  runImport
);

export default router;
