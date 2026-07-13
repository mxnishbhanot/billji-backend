import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Permission from '../src/models/Permission.js';
import Role from '../src/models/Role.js';
import { bootstrapRbac } from '../src/bootstrap/rbac.js';
import { ALL_PERMISSION_KEYS } from '../src/constants/permissions.js';
import { ROLE_PERMISSIONS, permissionsForMembership } from '../src/middlewares/authorization.js';
import { useMongoTestDb } from './helpers/db.js';

useMongoTestDb();

describe('bootstrapRbac', () => {
  it('seeds the full permission catalog and 5 system roles, idempotently', async () => {
    await bootstrapRbac();
    await bootstrapRbac(); // second run must not duplicate

    assert.equal(await Permission.countDocuments(), ALL_PERMISSION_KEYS.length);

    const systemRoles = await Role.find({ business: null, isSystem: true });
    assert.equal(systemRoles.length, 5);

    // Owner system role links every permission.
    const owner = systemRoles.find((r) => r.key === 'owner');
    assert.equal(owner.permissions.length, ALL_PERMISSION_KEYS.length);
  });

  it('leaves runtime permission resolution unchanged for an owner membership', async () => {
    await bootstrapRbac();
    // membership.role === null -> resolves via the static map, not the seeded DB role.
    const perms = await permissionsForMembership({ roleKey: 'owner', role: null });
    assert.deepEqual([...perms].sort(), [...ROLE_PERMISSIONS.owner].sort());
  });
});
