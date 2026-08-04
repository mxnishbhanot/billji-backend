import { Router } from 'express';
import {
  archiveRole,
  createRole,
  createRoleRules,
  deleteRole,
  getRole,
  listPermissionCatalog,
  listRoles,
  roleIdRules,
  updateRole,
  updateRoleRules
} from '../controllers/roleController.js';
import { FEATURES } from '../constants/entitlements.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { requireFeature } from '../middlewares/entitlement.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);

// Static path before '/:id' so it is not captured as a role id.
router.get('/permissions', requirePermission(PERMISSIONS.rolesView), listPermissionCatalog);

// Reading roles and taking a custom role out of service stay open — a downgraded business must be
// able to see and undo what it built. Creating and editing custom roles is the paid feature.
const customRolesFeature = requireFeature(FEATURES.customRoles);

router.get('/', requirePermission(PERMISSIONS.rolesView), listRoles);
router.post('/', requirePermission(PERMISSIONS.rolesManage), customRolesFeature, createRoleRules, validate, createRole);
router.get('/:id', requirePermission(PERMISSIONS.rolesView), roleIdRules, validate, getRole);
router.patch('/:id', requirePermission(PERMISSIONS.rolesManage), customRolesFeature, updateRoleRules, validate, updateRole);
router.post('/:id/archive', requirePermission(PERMISSIONS.rolesManage), roleIdRules, validate, archiveRole);
router.delete('/:id', requirePermission(PERMISSIONS.rolesManage), roleIdRules, validate, deleteRole);

export default router;
