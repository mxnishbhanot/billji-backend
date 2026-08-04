import Plan from '../models/Plan.js';
import { PLAN_SEEDS } from '../constants/entitlements.js';
import { clearPlanCache } from '../services/entitlementService.js';

// Idempotent plan seeding from the catalog, run on every server start. Same role and shape as
// bootstrap/rbac.js.
//
// Two rules, both learned the hard way in this codebase:
//
// 1. A seeder that is not idempotent breaks the second boot. Everything here is an upsert keyed
//    on `key`.
// 2. A seeder must not stomp deliberate admin edits. Plans are admin-editable rows, so an
//    existing plan only gets its *presentation* refreshed (name, tagline, description, badge,
//    sortOrder). Its prices, features, limits, visibility and trial/grace terms are left exactly
//    as the admin left them — otherwise every deploy would silently revert a price change.
//
// Use `bootstrapBilling({ force: true })` (dev, tests, a deliberate reset) to push catalog values
// over existing rows.

const PRESENTATION_FIELDS = ['name', 'tagline', 'description', 'badge', 'sortOrder'];

const seedFields = (seed) => ({
  name: seed.name,
  tagline: seed.tagline || '',
  description: seed.description || '',
  badge: seed.badge || '',
  sortOrder: seed.sortOrder ?? 100,
  visibility: seed.visibility || 'public',
  status: 'active',
  isDefault: Boolean(seed.isDefault),
  prices: seed.prices || [],
  features: seed.features || {},
  limits: seed.limits || {},
  trial: seed.trial || { enabled: false, days: 0 },
  grace: seed.grace || { days: 0 },
  meta: seed.meta || {}
});

export const bootstrapBilling = async ({ force = false } = {}) => {
  const results = { created: [], refreshed: [], forced: [] };

  for (const seed of PLAN_SEEDS) {
    const existing = await Plan.findOne({ key: seed.key });

    if (!existing) {
      // Document create (not findOneAndUpdate) so the pre-validate hook checks every feature and
      // limit key against the catalog. A typo in PLAN_SEEDS must fail the boot, loudly.
      await Plan.create({ key: seed.key, ...seedFields(seed) });
      results.created.push(seed.key);
      continue;
    }

    if (force) {
      Object.assign(existing, seedFields(seed));
      // Entitlements changed, so anyone re-snapshotted from this plan gets the new set.
      existing.version += 1;
      await existing.save();
      results.forced.push(seed.key);
      continue;
    }

    const fields = seedFields(seed);
    let changed = false;
    for (const field of PRESENTATION_FIELDS) {
      if (existing[field] !== fields[field]) {
        existing[field] = fields[field];
        changed = true;
      }
    }
    // Presentation-only: no version bump, because no entitlement changed.
    if (changed) {
      await existing.save();
      results.refreshed.push(seed.key);
    }
  }

  clearPlanCache();
  return results;
};
