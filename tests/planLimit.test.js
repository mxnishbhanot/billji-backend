import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Business from '../src/models/Business.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { applyPlan, ensureSubscription } from '../src/services/subscriptionService.js';
import { canInvite, getMemberLimit } from '../src/services/teamLimitService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const invite = (token, email) =>
  request(app).post('/api/v1/team/invitations').set(authHeader(token)).send({ email, roleKey: 'staff' });

describe('pre-billing businesses keep their historical cap', () => {
  it('derives the limit from the legacy plan key and honors an explicit override', () => {
    assert.equal(getMemberLimit(undefined), 2); // legacy business, no plan -> free
    assert.equal(getMemberLimit({ plan: { key: 'pro' } }), 5);
    assert.equal(getMemberLimit({ plan: { key: 'free', maxMembers: 9 } }), 9); // override wins
  });

  it('lets a legacy pro business exceed the free cap', async () => {
    const owner = await createTestContext();
    await Business.updateOne({ _id: owner.business._id }, { $set: { 'plan.key': 'pro' } });

    // Free would block the 2nd invite (1 active + 1 pending = 2). Pro (5) allows it.
    const first = await invite(owner.token, 'a@billji.local');
    assert.equal(first.status, 201, first.text);
    const second = await invite(owner.token, 'b@billji.local');
    assert.equal(second.status, 201, second.text);
  });

  it('uses the legacy cap while no subscription exists, even once plans are seeded', async () => {
    clearPlanCache();
    await bootstrapBilling();
    const owner = await createTestContext();

    // No Subscription row => predates billing. Starter's 1-seat cap must not apply retroactively.
    assert.equal(await Subscription.countDocuments({ business: owner.business._id }), 0);
    const { allowed, limit } = await canInvite(owner.business);
    assert.equal(limit, 2);
    assert.equal(allowed, true);
  });
});

describe('subscribed businesses read the limit engine', () => {
  const seeded = async () => {
    clearPlanCache();
    await bootstrapBilling();
    const owner = await createTestContext();
    await ensureSubscription({ business: owner.business });
    return owner;
  };

  it('gives Starter one seat, already taken by the owner', async () => {
    const owner = await seeded();
    const { allowed, limit, count } = await canInvite(owner.business);

    assert.equal(limit, 1);
    assert.equal(count, 1);
    assert.equal(allowed, false);

    const response = await invite(owner.token, 'blocked@billji.local');
    assert.equal(response.status, 403, response.text);
  });

  it('gives Business ten seats', async () => {
    const owner = await seeded();
    const plan = await Plan.findOne({ key: 'business' });
    await applyPlan({ business: owner.business, plan, interval: 'year' });

    const { allowed, limit } = await canInvite(owner.business);
    assert.equal(limit, 10);
    assert.equal(allowed, true);

    const response = await invite(owner.token, 'teammate@billji.local');
    assert.equal(response.status, 201, response.text);
  });

  it('counts a pending invitation as an occupied seat', async () => {
    const owner = await seeded();
    const plan = await Plan.findOne({ key: 'business' });
    await applyPlan({ business: owner.business, plan, interval: 'year' });
    await invite(owner.token, 'pending@billji.local');

    const { count } = await canInvite(owner.business);
    assert.equal(count, 2, 'an invitee with no member row yet still reserves a seat');
  });

  it('reports Infinity for an unlimited seat allowance, not the -1 sentinel', async () => {
    const owner = await seeded();
    const plan = await Plan.findOne({ key: 'enterprise' });
    await applyPlan({ business: owner.business, plan, interval: 'custom', periodEnd: null });

    const { allowed, limit } = await canInvite(owner.business);
    assert.equal(limit, Infinity);
    assert.equal(allowed, true);
  });

  it('honors a per-customer override over the plan snapshot', async () => {
    const owner = await seeded();
    const subscription = await Subscription.findOne({ business: owner.business._id });
    subscription.overrides.limits.set('team_members', 4);
    await subscription.save();

    const { allowed, limit } = await canInvite(owner.business);
    assert.equal(limit, 4);
    assert.equal(allowed, true);
  });

  it('grandfathers a legacy business onto two seats, so nobody loses a member', async () => {
    const owner = await seeded();
    const legacy = await Plan.findOne({ key: 'legacy_pro' });
    await applyPlan({ business: owner.business, plan: legacy });

    // The pre-billing free cap was 2. legacy_pro must not shrink it to Pro's 1.
    const { allowed, limit } = await canInvite(owner.business);
    assert.equal(limit, 2);
    assert.equal(allowed, true);
  });
});
