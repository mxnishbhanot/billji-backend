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
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);

// Static path before '/:id' so it is not captured as a role id.
router.get('/permissions', requirePermission(PERMISSIONS.rolesView), listPermissionCatalog);

router.get('/', requirePermission(PERMISSIONS.rolesView), listRoles);
router.post('/', requirePermission(PERMISSIONS.rolesManage), createRoleRules, validate, createRole);
router.get('/:id', requirePermission(PERMISSIONS.rolesView), roleIdRules, validate, getRole);
router.patch('/:id', requirePermission(PERMISSIONS.rolesManage), updateRoleRules, validate, updateRole);
router.post('/:id/archive', requirePermission(PERMISSIONS.rolesManage), roleIdRules, validate, archiveRole);
router.delete('/:id', requirePermission(PERMISSIONS.rolesManage), roleIdRules, validate, deleteRole);

export default router;
