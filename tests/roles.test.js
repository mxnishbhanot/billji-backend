import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import BusinessMember from '../src/models/BusinessMember.js';
import { bootstrapRbac } from '../src/bootstrap/rbac.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const ROLES = '/api/v1/roles';
const TEAM = '/api/v1/team';

const createCustomRole = (token, body) => request(app).post(ROLES).set(authHeader(token)).send(body);

describe('roles CRUD + permission catalog', () => {
  it('serves the grouped permission catalog', async () => {
    await bootstrapRbac();
    const owner = await createTestContext();
    const res = await request(app).get(`${ROLES}/permissions`).set(authHeader(owner.token));
    assert.equal(res.status, 200, res.text);
    assert.ok(res.body.groups.some((g) => g.domain === 'invoices'));
  });

  it('lists the 5 seeded system roles', async () => {
    await bootstrapRbac();
    const owner = await createTestContext();
    const res = await request(app).get(ROLES).set(authHeader(owner.token));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.roles.filter((r) => r.isSystem).length, 5);
  });

  it('creates a custom role and echoes its permissions', async () => {
    await bootstrapRbac();
    const owner = await createTestContext();
    const res = await createCustomRole(owner.token, {
      name: 'Sales Lead',
      permissions: ['invoices.view', 'invoices.create']
    });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.role.isSystem, false);
    assert.deepEqual([...res.body.role.permissions].sort(), ['invoices.create', 'invoices.view']);
  });

  it('rejects unknown permission keys', async () => {
    await bootstrapRbac();
    const owner = await createTestContext();
    const res = await createCustomRole(owner.token, { name: 'Bad', permissions: ['invoices.teleport'] });
    assert.equal(res.status, 422, res.text);
  });

  it('refuses to edit a system role', async () => {
    await bootstrapRbac();
    const owner = await createTestContext();
    const list = await request(app).get(ROLES).set(authHeader(owner.token));
    const system = list.body.roles.find((r) => r.isSystem);
    const res = await request(app).patch(`${ROLES}/${system.id}`).set(authHeader(owner.token)).send({ name: 'Hacked' });
    assert.equal(res.status, 403, res.text);
  });

  it('deletes an unused custom role but blocks deletion of one in use', async () => {
    await bootstrapRbac();
    const owner = await createTestContext();
    const created = await createCustomRole(owner.token, { name: 'Temp', permissions: ['invoices.view'] });
    const roleId = created.body.role.id;

    // Unused -> deletable.
    const del = await request(app).delete(`${ROLES}/${roleId}`).set(authHeader(owner.token));
    assert.equal(del.status, 200, del.text);

    // Recreate, assign to a member, then deletion is blocked.
    const again = await createCustomRole(owner.token, { name: 'Temp2', permissions: ['invoices.view'] });
    const roleId2 = again.body.role.id;
    const invite = await request(app).post(`${TEAM}/invitations`).set(authHeader(owner.token)).send({ email: 'm@billji.local', roleKey: 'staff' });
    await request(app).post(`${TEAM}/invitations/accept`).send({ token: invite.body.inviteToken, name: 'M', password: 'password123' });
    const member = await BusinessMember.findOne({ business: owner.business._id, roleKey: 'staff', status: 'active' }).populate('user', '_id');

    const assign = await request(app).patch(`${TEAM}/members/${member.user._id}/role`).set(authHeader(owner.token)).send({ roleId: roleId2 });
    assert.equal(assign.status, 200, assign.text);
    const updated = await BusinessMember.findById(member._id);
    assert.equal(String(updated.role), String(roleId2));

    const delInUse = await request(app).delete(`${ROLES}/${roleId2}`).set(authHeader(owner.token));
    assert.equal(delInUse.status, 409, delInUse.text);
  });

  it('archives a custom role so it drops out of the active list', async () => {
    await bootstrapRbac();
    const owner = await createTestContext();
    const created = await createCustomRole(owner.token, { name: 'Seasonal', permissions: ['invoices.view'] });
    const roleId = created.body.role.id;

    const archive = await request(app).post(`${ROLES}/${roleId}/archive`).set(authHeader(owner.token));
    assert.equal(archive.status, 200, archive.text);

    const list = await request(app).get(ROLES).set(authHeader(owner.token));
    assert.equal(list.body.roles.some((r) => r.id === roleId), false);
  });
});
