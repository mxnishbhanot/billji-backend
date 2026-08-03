import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import Business from '../src/models/Business.js';
import BusinessMember from '../src/models/BusinessMember.js';
import Session from '../src/models/Session.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const API = '/api/v1/auth';

describe('workspace switching', () => {
  it('lists memberships and switches the active business', async () => {
    const ctx = await createTestContext(); // owner of business #1
    const second = await Business.create({ owner: ctx.user._id, businessName: 'Second Co', invoicePrefix: 'SEC' });
    await BusinessMember.create({ business: second._id, user: ctx.user._id, roleKey: 'staff', status: 'active' });

    const list = await request(app).get(`${API}/businesses`).set(authHeader(ctx.token));
    assert.equal(list.status, 200, list.text);
    assert.equal(list.body.businesses.length, 2);

    const res = await request(app).post(`${API}/business/switch`).set(authHeader(ctx.token)).send({ businessId: second._id });
    assert.equal(res.status, 200, res.text);
    assert.equal(String(res.body.user.businessId), String(second._id));
    assert.equal(res.body.user.roleKey, 'staff');

    // /me now resolves the switched business.
    const me = await request(app).get(`${API}/me`).set(authHeader(ctx.token));
    assert.equal(String(me.body.user.businessId), String(second._id));
    assert.equal(me.body.user.roleKey, 'staff');
  });

  it('refuses to switch to a business the user is not a member of', async () => {
    const ctx = await createTestContext();
    const other = await Business.create({ owner: ctx.user._id, businessName: 'Not Mine', invoicePrefix: 'NM' });
    // No membership — switch must fail.
    const res = await request(app).post(`${API}/business/switch`).set(authHeader(ctx.token)).send({ businessId: other._id });
    assert.equal(res.status, 403, res.text);
  });

  it('refresh returns the switched business, not the login-time business', async () => {
    const password = 'password123';
    const ctx = await createTestContext();
    // createTestContext already hashed via User.create; login with that password.
    const second = await Business.create({ owner: ctx.user._id, businessName: 'Second Co', invoicePrefix: 'SEC' });
    await BusinessMember.create({ business: second._id, user: ctx.user._id, roleKey: 'staff', status: 'active' });

    const login = await request(app).post(`${API}/login`).send({ email: ctx.user.email, password });
    assert.equal(login.status, 200, login.text);
    assert.ok(login.body.refreshToken);
    assert.equal(String(login.body.user.businessId), String(ctx.business._id));

    const sessionBefore = await Session.findById(login.body.sessionId);
    assert.equal(String(sessionBefore.business), String(ctx.business._id));

    const switched = await request(app)
      .post(`${API}/business/switch`)
      .set(authHeader(login.body.accessToken || login.body.token))
      .send({ businessId: second._id });
    assert.equal(switched.status, 200, switched.text);
    assert.equal(String(switched.body.user.businessId), String(second._id));

    const refreshed = await request(app).post(`${API}/refresh`).send({ refreshToken: login.body.refreshToken });
    assert.equal(refreshed.status, 200, refreshed.text);
    assert.equal(String(refreshed.body.user.businessId), String(second._id));
    assert.equal(refreshed.body.user.roleKey, 'staff');

    const sessionAfter = await Session.findById(login.body.sessionId);
    assert.equal(String(sessionAfter.business), String(second._id));
  });
});
