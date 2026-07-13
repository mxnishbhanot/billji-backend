import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import Business from '../src/models/Business.js';
import BusinessMember from '../src/models/BusinessMember.js';
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
    const res = await request(app).post(`${API}/business/switch`).set(authHeader(ctx.token)).send({ businessId: other._id });
    assert.equal(res.status, 403, res.text);
  });
});
