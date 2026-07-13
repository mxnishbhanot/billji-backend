import assert from 'node:assert/strict';
import crypto from 'crypto';
import { describe, it } from 'node:test';
import BusinessInvitation from '../src/models/BusinessInvitation.js';
import BusinessMember from '../src/models/BusinessMember.js';
import { useMongoTestDb } from './helpers/db.js';
import { createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

describe('RBAC model extensions', () => {
  it('accepts the new BusinessMember lifecycle statuses and rejects legacy "disabled"', async () => {
    const { business, user } = await createTestContext();

    const archived = await BusinessMember.create({
      business: business._id,
      user: (await createTestContext()).user._id,
      roleKey: 'staff',
      status: 'archived',
      archivedAt: new Date(),
      archivedBy: user._id
    });
    assert.equal(archived.status, 'archived');

    await assert.rejects(
      BusinessMember.create({ business: business._id, user: user._id, roleKey: 'staff', status: 'disabled' }),
      /validation/i
    );
  });

  it('creates a BusinessInvitation with a role snapshot', async () => {
    const { business, user } = await createTestContext();
    const invite = await BusinessInvitation.create({
      business: business._id,
      email: 'invitee@billji.local',
      roleKey: 'accountant',
      roleName: 'Accountant',
      tokenHash: crypto.randomBytes(16).toString('hex'),
      invitedBy: user._id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    });
    assert.equal(invite.status, 'pending');
    assert.equal(invite.roleName, 'Accountant');
  });
});
