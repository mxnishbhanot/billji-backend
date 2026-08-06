import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Business from '../src/models/Business.js';
import BusinessMember from '../src/models/BusinessMember.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import User from '../src/models/User.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { applyPlan, ensureSubscription } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

// The other half of owner-only billing: a member who cannot buy a plan for someone else's business
// must have a business of their own to buy one for. Without this, the guard is just a dead end.

useMongoTestDb();

afterEach(() => {
  delete process.env.BILLING_ENFORCEMENT;
});

const seeded = async (roleKey = 'owner') => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext({ roleKey });
  await ensureSubscription({ business: context.business });
  return context;
};

const create = (token, body) => request(app).post('/api/v1/businesses').set(authHeader(token)).send(body);

describe('POST /businesses', () => {
  it('gives a viewer in someone else\'s business their first workspace, ungated', async () => {
    const employer = await seeded('owner');
    await applyPlan({ business: employer.business._id, plan: await Plan.findOne({ key: 'pro' }) });

    // Ravi: a viewer in Rohit's Pro business, owning nothing himself.
    const ravi = await User.create({ name: 'Ravi', email: 'ravi@billji.local', password: 'password123' });
    await BusinessMember.create({ business: employer.business._id, user: ravi._id, roleKey: 'viewer', status: 'active' });
    ravi.defaultBusiness = employer.business._id;
    await ravi.save();
    const { signToken } = await import('../src/utils/jwt.js');

    const response = await create(signToken(ravi._id), { businessName: 'Ravi Traders' });
    assert.equal(response.status, 201, response.text);

    const created = await Business.findOne({ businessName: 'Ravi Traders' });
    assert.equal(String(created.owner), String(ravi._id));

    const membership = await BusinessMember.findOne({ business: created._id, user: ravi._id });
    assert.equal(membership.roleKey, 'owner');
    assert.equal(membership.status, 'active');

    // Switched into it, on the default plan, and able to spend there.
    assert.equal(String((await User.findById(ravi._id)).defaultBusiness), String(created._id));
    assert.ok(await Subscription.findOne({ business: created._id }), 'a subscription should be provisioned');
    assert.equal(response.body.user.roleKey, 'owner');
    assert.equal(response.body.user.subscription.canManageBilling, true);
  });

  it('leaves the employer\'s subscription completely untouched', async () => {
    const employer = await seeded('owner');
    await applyPlan({ business: employer.business._id, plan: await Plan.findOne({ key: 'pro' }) });

    const ravi = await User.create({ name: 'Ravi Two', email: 'ravi2@billji.local', password: 'password123' });
    await BusinessMember.create({ business: employer.business._id, user: ravi._id, roleKey: 'viewer', status: 'active' });
    ravi.defaultBusiness = employer.business._id;
    await ravi.save();
    const { signToken } = await import('../src/utils/jwt.js');

    const before = (await Subscription.findOne({ business: employer.business._id })).toObject();
    assert.equal((await create(signToken(ravi._id), { businessName: 'Ravi Traders Two' })).status, 201);
    const after = (await Subscription.findOne({ business: employer.business._id })).toObject();

    assert.deepEqual(after, before);
  });

  it('meters the second owned workspace against the caller\'s own plan, not their employer\'s', async () => {
    process.env.BILLING_ENFORCEMENT = 'on';
    // Owner of a Starter business, which caps `businesses` at 1.
    const owner = await seeded('owner');

    const response = await create(owner.token, { businessName: 'Second Shop' });
    assert.equal(response.status, 402, response.text);
    assert.equal(await Business.countDocuments({ owner: owner.user._id, status: 'active' }), 1);
  });

  it('rejects a nameless workspace', async () => {
    const owner = await seeded('owner');
    assert.equal((await create(owner.token, { businessName: '   ' })).status, 422);
  });

  it('replays rather than duplicating when the same name is submitted twice', async () => {
    // A double tap must not cost the caller a slot of their `businesses` allowance. The guard is on
    // owner + name, not an idempotency header: the header-based middleware scopes keys to the
    // current business, and this route changes which business that is.
    const ravi = await User.create({ name: 'Ravi Three', email: 'ravi3@billji.local', password: 'password123' });
    const employer = await seeded('owner');
    await BusinessMember.create({ business: employer.business._id, user: ravi._id, roleKey: 'viewer', status: 'active' });
    ravi.defaultBusiness = employer.business._id;
    await ravi.save();
    const { signToken } = await import('../src/utils/jwt.js');
    const token = signToken(ravi._id);

    const first = await create(token, { businessName: 'Only Once' });
    const second = await create(token, { businessName: 'Only Once' });

    assert.equal(first.status, 201, first.text);
    assert.equal(second.status, 200, second.text);
    assert.equal(await Business.countDocuments({ businessName: 'Only Once' }), 1);
  });
});
