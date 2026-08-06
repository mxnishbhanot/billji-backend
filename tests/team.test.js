import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import BusinessMember from '../src/models/BusinessMember.js';
import Session from '../src/models/Session.js';
import User from '../src/models/User.js';
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

  it('stops an admin from unmaking an owner', async () => {
    // Symmetric with "no escalation" above, and load-bearing now that billing is gated on
    // ownership: an admin who can demote the owner can seize the business's billing authority.
    // Two owners, so the last-owner guard is not what is doing the work here.
    const owner = await createTestContext();
    const admin = await createTestContext({ roleKey: 'admin' });
    await BusinessMember.updateOne({ _id: admin.membership._id }, { $set: { business: owner.business._id } });
    const secondOwner = await createTestContext();
    await BusinessMember.updateOne({ _id: secondOwner.membership._id }, { $set: { business: owner.business._id } });
    await User.updateOne({ _id: admin.user._id }, { $set: { defaultBusiness: owner.business._id } });

    const demote = await request(app).patch(`${API}/members/${owner.user._id}/role`).set(authHeader(admin.token)).send({ roleKey: 'viewer' });
    assert.equal(demote.status, 403, demote.text);

    const archive = await request(app).patch(`${API}/members/${owner.user._id}/status`).set(authHeader(admin.token)).send({ status: 'archived' });
    assert.equal(archive.status, 403, archive.text);

    const remove = await request(app).delete(`${API}/members/${owner.user._id}`).set(authHeader(admin.token));
    assert.equal(remove.status, 403, remove.text);

    assert.equal((await BusinessMember.findById(owner.membership._id)).roleKey, 'owner');
  });

  it('lets an owner demote another owner', async () => {
    const owner = await createTestContext();
    const secondOwner = await createTestContext();
    await BusinessMember.updateOne({ _id: secondOwner.membership._id }, { $set: { business: owner.business._id } });

    const res = await request(app).patch(`${API}/members/${secondOwner.user._id}/role`).set(authHeader(owner.token)).send({ roleKey: 'viewer' });
    assert.equal(res.status, 200, res.text);
    assert.equal((await BusinessMember.findById(secondOwner.membership._id)).roleKey, 'viewer');
  });

  it('leaves nothing pointing at a workspace a removed member can no longer act in', async () => {
    const owner = await createTestContext();
    const inviteRes = await invite(owner.token, { email: 'goodbye@billji.local', roleKey: 'staff' });
    const accepted = await request(app)
      .post(`${API}/invitations/accept`)
      .send({ token: inviteRes.body.inviteToken, name: 'Goodbye', password: 'password123' });
    const memberId = accepted.body.user.id;

    assert.equal(String((await User.findById(memberId)).defaultBusiness), String(owner.business._id));
    assert.ok((await Session.countDocuments({ user: memberId })) > 0, 'accepting an invite issues a session');

    assert.equal((await request(app).delete(`${API}/members/${memberId}`).set(authHeader(owner.token))).status, 200);

    assert.equal((await User.findById(memberId)).defaultBusiness, null);
    assert.equal(await Session.countDocuments({ user: memberId }), 0);
  });
});
