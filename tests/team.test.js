import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import BusinessMember from '../src/models/BusinessMember.js';
import { bootstrapRbac } from '../src/bootstrap/rbac.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const API = '/api/v1/team';

const invite = (token, body) => request(app).post(`${API}/invitations`).set(authHeader(token)).send(body);

describe('team management', () => {
  it('owner invites a new user who accepts and becomes an active staff member', async () => {
    const owner = await createTestContext();

    const inviteRes = await invite(owner.token, { email: 'newbie@billji.local', roleKey: 'staff' });
    assert.equal(inviteRes.status, 201, inviteRes.text);
    const token = inviteRes.body.inviteToken;
    assert.ok(token, 'dev invite token returned');

    const acceptRes = await request(app)
      .post(`${API}/invitations/accept`)
      .send({ token, name: 'Newbie', password: 'password123' });
    assert.equal(acceptRes.status, 201, acceptRes.text);
    assert.equal(acceptRes.body.joined, true);
    assert.equal(acceptRes.body.user.roleKey, 'staff');
    assert.ok(acceptRes.body.token, 'session issued for new user');

    const membersRes = await request(app).get(`${API}/members`).set(authHeader(owner.token));
    assert.equal(membersRes.status, 200);
    const newbie = membersRes.body.members.find((m) => m.email === 'newbie@billji.local');
    assert.equal(newbie.status, 'active');
    assert.equal(newbie.roleKey, 'staff');
  });

  it('rejects a non-manager (staff) from inviting', async () => {
    const staff = await createTestContext({ roleKey: 'staff' });
    const res = await invite(staff.token, { email: 'x@billji.local', roleKey: 'viewer' });
    assert.equal(res.status, 403, res.text);
  });

  it('prevents an admin from granting the owner role (no escalation)', async () => {
    const admin = await createTestContext({ roleKey: 'admin' });
    const res = await invite(admin.token, { email: 'x@billji.local', roleKey: 'owner' });
    assert.equal(res.status, 403, res.text);
  });

  it('blocks removing the last active owner', async () => {
    const owner = await createTestContext();
    const res = await request(app).delete(`${API}/members/${owner.user._id}`).set(authHeader(owner.token));
    assert.equal(res.status, 409, res.text);
  });

  it('enforces the team member limit', async () => {
    const owner = await createTestContext(); // 1 active seat
    const first = await invite(owner.token, { email: 'a@billji.local', roleKey: 'staff' });
    assert.equal(first.status, 201, first.text); // now 2 seats (1 active + 1 pending)
    const second = await invite(owner.token, { email: 'b@billji.local', roleKey: 'staff' });
    assert.equal(second.status, 403, second.text);
    assert.equal(second.body.details?.code || second.body.code, 'MEMBER_LIMIT_REACHED');
  });

  it('invites with a custom role and the accepted member carries it', async () => {
    await bootstrapRbac();
    const owner = await createTestContext();
    const role = await request(app)
      .post('/api/v1/roles')
      .set(authHeader(owner.token))
      .send({ name: 'Cashier', permissions: ['invoices.view', 'payments.record'] });
    assert.equal(role.status, 201, role.text);

    const inviteRes = await invite(owner.token, { email: 'cashier@billji.local', roleId: role.body.role.id });
    assert.equal(inviteRes.status, 201, inviteRes.text);
    assert.equal(inviteRes.body.invitation.roleName, 'Cashier');

    const acceptRes = await request(app)
      .post(`${API}/invitations/accept`)
      .send({ token: inviteRes.body.inviteToken, name: 'Cash', password: 'password123' });
    assert.equal(acceptRes.status, 201, acceptRes.text);

    const members = await request(app).get(`${API}/members`).set(authHeader(owner.token));
    const cashier = members.body.members.find((m) => m.email === 'cashier@billji.local');
    assert.equal(cashier.roleName, 'Cashier');
    assert.equal(cashier.status, 'active');
  });

  it('re-roles an existing member within the granter’s authority', async () => {
    const owner = await createTestContext();
    const inviteRes = await invite(owner.token, { email: 'promote@billji.local', roleKey: 'staff' });
    await request(app)
      .post(`${API}/invitations/accept`)
      .send({ token: inviteRes.body.inviteToken, name: 'Promote Me', password: 'password123' });
    const member = await BusinessMember.findOne({ business: owner.business._id, roleKey: 'staff', status: 'active' }).populate('user', '_id');

    const res = await request(app)
      .patch(`${API}/members/${member.user._id}/role`)
      .set(authHeader(owner.token))
      .send({ roleKey: 'admin' });
    assert.equal(res.status, 200, res.text);

    const updated = await BusinessMember.findById(member._id);
    assert.equal(updated.roleKey, 'admin');
  });
});
