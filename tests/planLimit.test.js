import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import Business from '../src/models/Business.js';
import { getMemberLimit } from '../src/services/teamLimitService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

describe('plan-driven team limit', () => {
  it('derives the limit from the plan key and honors an explicit override', () => {
    assert.equal(getMemberLimit(undefined), 2); // legacy business, no plan -> free
    assert.equal(getMemberLimit({ plan: { key: 'pro' } }), 5);
    assert.equal(getMemberLimit({ plan: { key: 'free', maxMembers: 9 } }), 9); // override wins
  });

  it('lets a pro business exceed the free cap', async () => {
    const owner = await createTestContext();
    await Business.updateOne({ _id: owner.business._id }, { $set: { 'plan.key': 'pro' } });

    // Free would block the 2nd invite (1 active + 1 pending = 2). Pro (5) allows it.
    const first = await request(app).post('/api/v1/team/invitations').set(authHeader(owner.token)).send({ email: 'a@billji.local', roleKey: 'staff' });
    assert.equal(first.status, 201, first.text);
    const second = await request(app).post('/api/v1/team/invitations').set(authHeader(owner.token)).send({ email: 'b@billji.local', roleKey: 'staff' });
    assert.equal(second.status, 201, second.text);
  });
});
