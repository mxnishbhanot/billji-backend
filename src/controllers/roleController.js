import { body, param } from 'express-validator';
import BusinessInvitation from '../models/BusinessInvitation.js';
import BusinessMember from '../models/BusinessMember.js';
import Permission from '../models/Permission.js';
import Role from '../models/Role.js';
import { ALL_PERMISSION_KEYS, PERMISSION_GROUPS } from '../constants/permissions.js';
import { logAudit } from '../services/auditService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const slugify = (value) =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

// No-escalation: a role's permissions must be a subset of the actor's own permissions
// (req.permissions is set by requirePermission). Also rejects unknown permission keys.
const assertPermissionsWithinActor = (req, permissionKeys) => {
  const unknown = permissionKeys.filter((key) => !ALL_PERMISSION_KEYS.includes(key));
  if (unknown.length) throw new ApiError(422, 'Unknown permission keys', { code: 'UNKNOWN_PERMISSIONS', unknown });

  const actorPermissions = new Set(req.permissions || []);
  const escalates = permissionKeys.filter((key) => !actorPermissions.has(key));
  if (escalates.length) {
    throw new ApiError(403, 'You cannot grant permissions beyond your own', { code: 'PERMISSION_ESCALATION', escalates });
  }
};

const permissionKeysToIds = async (keys) => {
  const docs = await Permission.find({ key: { $in: keys } }).select('_id key');
  return docs.map((d) => d._id);
};

const serializeRole = (role) => ({
  id: role._id,
  key: role.key,
  name: role.name,
  description: role.description,
  isSystem: role.isSystem,
  isArchived: role.isArchived,
  permissions: (role.permissions || []).map((p) => (p.key ? p.key : p))
});

// --- validation -------------------------------------------------------------

export const createRoleRules = [
  body('name').trim().notEmpty().withMessage('Role name is required').isLength({ max: 80 }),
  body('key').optional().trim().isLength({ max: 60 }),
  body('description').optional().trim().isLength({ max: 240 }),
  body('permissions').isArray({ min: 1 }).withMessage('Select at least one permission'),
  body('permissions.*').isString()
];

export const updateRoleRules = [
  param('id').isMongoId().withMessage('Valid role id is required'),
  body('name').optional().trim().notEmpty().isLength({ max: 80 }),
  body('description').optional().trim().isLength({ max: 240 }),
  body('permissions').optional().isArray({ min: 1 }).withMessage('Select at least one permission'),
  body('permissions.*').optional().isString()
];

export const roleIdRules = [param('id').isMongoId().withMessage('Valid role id is required')];

// --- handlers ---------------------------------------------------------------

export const listPermissionCatalog = asyncHandler(async (_req, res) => {
  res.json({ success: true, groups: PERMISSION_GROUPS });
});

export const listRoles = asyncHandler(async (req, res) => {
  const roles = await Role.find({
    $or: [{ business: null }, { business: req.business._id }],
    isArchived: false
  })
    .populate('permissions', 'key')
    .sort({ isSystem: -1, name: 1 });

  res.json({ success: true, roles: roles.map(serializeRole) });
});

// Fetch a role that this business is allowed to see (a system role or its own custom role).
const findVisibleRole = async (req) => {
  const role = await Role.findOne({
    _id: req.params.id,
    $or: [{ business: null }, { business: req.business._id }]
  }).populate('permissions', 'key');
  if (!role) throw new ApiError(404, 'Role not found');
  return role;
};

export const getRole = asyncHandler(async (req, res) => {
  const role = await findVisibleRole(req);
  res.json({ success: true, role: serializeRole(role) });
});

export const createRole = asyncHandler(async (req, res) => {
  const permissionKeys = [...new Set(req.body.permissions)];
  assertPermissionsWithinActor(req, permissionKeys);

  const key = slugify(req.body.key || req.body.name);
  if (!key) throw new ApiError(422, 'Role key could not be derived from the name');

  let role;
  try {
    role = await Role.create({
      business: req.business._id,
      key,
      name: req.body.name,
      description: req.body.description || '',
      permissions: await permissionKeysToIds(permissionKeys),
      isSystem: false,
      createdBy: req.user._id,
      updatedBy: req.user._id
    });
  } catch (err) {
    if (err?.code === 11000) throw new ApiError(409, 'A role with this key already exists');
    throw err;
  }

  void logAudit(req, { action: 'role.created', resourceType: 'role', resourceId: role._id, metadata: { key, permissions: permissionKeys } });
  await role.populate('permissions', 'key');
  res.status(201).json({ success: true, role: serializeRole(role) });
});

export const updateRole = asyncHandler(async (req, res) => {
  const role = await findVisibleRole(req);
  if (role.isSystem) throw new ApiError(403, 'System roles cannot be edited');
  if (String(role.business) !== String(req.business._id)) throw new ApiError(404, 'Role not found');

  const before = { name: role.name, description: role.description, permissions: serializeRole(role).permissions };
  const changedKeys = [];

  if (req.body.name !== undefined && req.body.name !== role.name) {
    role.name = req.body.name;
    changedKeys.push('name');
  }
  if (req.body.description !== undefined && req.body.description !== role.description) {
    role.description = req.body.description;
    changedKeys.push('description');
  }
  if (req.body.permissions !== undefined) {
    const permissionKeys = [...new Set(req.body.permissions)];
    assertPermissionsWithinActor(req, permissionKeys);
    role.permissions = await permissionKeysToIds(permissionKeys);
    changedKeys.push('permissions');
  }

  if (!changedKeys.length) {
    await role.populate('permissions', 'key');
    return res.json({ success: true, role: serializeRole(role) });
  }

  role.updatedBy = req.user._id;
  await role.save();
  await role.populate('permissions', 'key');
  const after = { name: role.name, description: role.description, permissions: serializeRole(role).permissions };
  void logAudit(req, { action: 'role.updated', resourceType: 'role', resourceId: role._id, metadata: { before, after, changedKeys } });

  res.json({ success: true, role: serializeRole(role) });
});

export const archiveRole = asyncHandler(async (req, res) => {
  const role = await findVisibleRole(req);
  if (role.isSystem) throw new ApiError(403, 'System roles cannot be archived');
  if (String(role.business) !== String(req.business._id)) throw new ApiError(404, 'Role not found');

  role.isArchived = true;
  role.archivedAt = new Date();
  role.archivedBy = req.user._id;
  await role.save();
  void logAudit(req, { action: 'role.archived', resourceType: 'role', resourceId: role._id });

  res.json({ success: true });
});

export const deleteRole = asyncHandler(async (req, res) => {
  const role = await findVisibleRole(req);
  if (role.isSystem) throw new ApiError(403, 'System roles cannot be deleted');
  if (String(role.business) !== String(req.business._id)) throw new ApiError(404, 'Role not found');

  // Never hard-delete a role still referenced by a member or a pending invitation — it
  // would orphan those references and break historical audit context. Archive instead.
  const [memberRef, inviteRef] = await Promise.all([
    BusinessMember.exists({ business: req.business._id, role: role._id }),
    BusinessInvitation.exists({ business: req.business._id, role: role._id, status: 'pending' })
  ]);
  if (memberRef || inviteRef) {
    throw new ApiError(409, 'This role is in use. Archive it instead of deleting.', { code: 'ROLE_IN_USE' });
  }

  await role.deleteOne();
  void logAudit(req, { action: 'role.deleted', resourceType: 'role', resourceId: role._id });

  res.json({ success: true });
});
