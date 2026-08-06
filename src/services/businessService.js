import Business from '../models/Business.js';
import BusinessMember from '../models/BusinessMember.js';
import { ensureSubscription } from './subscriptionService.js';

/**
 * Puts a brand-new business on the default plan. Never fatal: a signup must not fail because the
 * billing catalog has not been seeded, and resolveAccess() already falls back to the default plan
 * for a business with no subscription row, so the worst case is a row the reconciliation job
 * creates later.
 */
export const provisionSubscription = (business, note = 'signup') =>
  ensureSubscription({ business, actor: { type: 'system', note } }).catch((error) => {
    console.error('[billing] could not provision a subscription at signup:', error.message);
  });

/**
 * The one way a business comes into existence: the Business, its owner membership, and a
 * subscription on the default plan. Register, Google first sign-in and POST /businesses all route
 * through here so the three can never drift.
 *
 * INVARIANT, and the reason the two writes are separate:
 *   BusinessMember.roleKey is the AUTHORIZATION source of truth — every guard reads it.
 *   Business.owner is the BILLING CONTACT OF RECORD — display, and counting owned workspaces.
 * Nothing authorizes against Business.owner. A future ownership transfer updates both in one
 * operation; if they ever diverge, authorization still behaves correctly and only the
 * "Managed by" label goes stale.
 *
 * `session` is threaded but unused by today's callers: an ownership transfer needs a multi-document
 * write and will reuse this shape. Note transactions require a replica set — on a standalone
 * MongoDB the caller must fall back to ordered sequential writes.
 */
export const createBusinessForOwner = async ({ user, businessName, email, session = null, note = 'signup' }) => {
  const options = session ? { session } : {};
  const [business] = await Business.create([{ owner: user._id, businessName, email }], options);
  await BusinessMember.create([{ business: business._id, user: user._id, roleKey: 'owner', joinedAt: new Date() }], options);
  await provisionSubscription(business, note);

  return business;
};
