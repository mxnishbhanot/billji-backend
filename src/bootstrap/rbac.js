import Permission from '../models/Permission.js';
import Role from '../models/Role.js';
import { PERMISSION_GROUPS } from '../constants/permissions.js';
import { ROLE_PERMISSIONS } from '../middlewares/authorization.js';

// The five immutable system roles. business:null marks them as system-wide; isSystem
// blocks edit/delete in the role controller (Phase 4). Descriptions are display-only.
const SYSTEM_ROLES = [
  { key: 'owner', name: 'Owner', description: 'Full access. Cannot be edited or removed.' },
  { key: 'admin', name: 'Admin', description: 'Full access to run the business.' },
  { key: 'accountant', name: 'Accountant', description: 'Manage invoices, orders, payments and customers.' },
  { key: 'staff', name: 'Staff', description: 'Day-to-day sales operations.' },
  { key: 'viewer', name: 'Viewer', description: 'Read-only access.' }
];

// Idempotent: upserts the permission catalog and system roles from the canonical
// catalog. Safe to run on every server start. Runtime authorization still resolves via
// the static ROLE_PERMISSIONS map for owner-only memberships (role===null); these DB
// rows back the custom-role editor and the permission matrix.
export const bootstrapRbac = async () => {
  const keyToId = new Map();

  for (const group of PERMISSION_GROUPS) {
    for (const permission of group.permissions) {
      const doc = await Permission.findOneAndUpdate(
        { key: permission.key },
        { $set: { domain: group.domain, description: permission.label } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      keyToId.set(permission.key, doc._id);
    }
  }

  for (const role of SYSTEM_ROLES) {
    const permissionIds = (ROLE_PERMISSIONS[role.key] || []).map((key) => keyToId.get(key)).filter(Boolean);
    await Role.findOneAndUpdate(
      { business: null, key: role.key },
      { $set: { name: role.name, description: role.description, permissions: permissionIds, isSystem: true } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
};
