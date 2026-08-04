import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LIMITS, UNLIMITED } from '../src/constants/entitlements.js';
import SubscriptionUsage from '../src/models/SubscriptionUsage.js';
import {
  ALL_TIME,
  checkLimit,
  decrementUsage,
  incrementUsage,
  monthKeyFor,
  periodKeyFor,
  periodResetsAt,
  recordOverage,
  remainingUsage,
  setUsage,
  usageSummary
} from '../src/services/usageService.js';
import { useMongoTestDb } from './helpers/db.js';
import { createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const starter = { features: {}, limits: { documents_per_month: 200, team_members: 1, businesses: 1 } };
const pro = { features: {}, limits: { team_members: 1 } };

describe('period keys', () => {
  it('buckets monthly limits by business-time month', () => {
    assert.equal(periodKeyFor(LIMITS.documentsPerMonth, new Date('2026-06-15T00:00:00.000Z')), '2026-06');
  });

  it('puts a document billed at 00:30 IST on the 1st in the new month, not the old one', () => {
    // 2026-06-30T19:00Z is 2026-07-01T00:30 IST. UTC bucketing would file this under June.
    assert.equal(monthKeyFor(new Date('2026-06-30T19:00:00.000Z')), '2026-07');
    // And the last minute of June IST stays in June.
    assert.equal(monthKeyFor(new Date('2026-06-30T18:29:00.000Z')), '2026-06');
  });

  it('gives non-monthly limits a single permanent bucket', () => {
    assert.equal(periodKeyFor(LIMITS.teamMembers), ALL_TIME);
    assert.equal(periodResetsAt(LIMITS.teamMembers), null);
  });

  it('reports the next reset instant in business time', () => {
    const resetsAt = periodResetsAt(LIMITS.documentsPerMonth, new Date('2026-06-15T00:00:00.000Z'));
    // 2026-07-01T00:00 IST === 2026-06-30T18:30Z
    assert.equal(resetsAt.toISOString(), '2026-06-30T18:30:00.000Z');
  });

  it('throws on an unknown limit key', () => {
    assert.throws(() => periodKeyFor('documentsPerMonth'), /Unknown limit key/);
  });
});

describe('metered limits', () => {
  it('increments and reports remaining', async () => {
    const { business } = await createTestContext();
    const result = await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth });

    assert.equal(result.allowed, true);
    assert.equal(result.used, 1);
    assert.equal(result.remaining, 199);
    assert.equal(await remainingUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth }), 199);
  });

  it('allows exactly the limit and refuses the next one', async () => {
    const { business } = await createTestContext();
    await setUsage({ business: business._id, limitKey: LIMITS.documentsPerMonth, count: 199 });

    const at200 = await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth });
    assert.equal(at200.allowed, true);
    assert.equal(at200.used, 200);

    const at201 = await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth });
    assert.equal(at201.allowed, false);
    assert.equal(at201.used, 200, 'a refused increment must not consume usage');
  });

  it('never blocks an unlimited limit', async () => {
    const { business } = await createTestContext();
    await setUsage({ business: business._id, limitKey: LIMITS.documentsPerMonth, count: 99999 });

    const result = await incrementUsage({ business: business._id, entitlements: pro, limitKey: LIMITS.documentsPerMonth });
    assert.equal(result.allowed, true);
    assert.equal(result.unlimited, true);
    assert.equal(result.limit, UNLIMITED);
  });

  it('respects an amount greater than one without overshooting the ceiling', async () => {
    const { business } = await createTestContext();
    await setUsage({ business: business._id, limitKey: LIMITS.documentsPerMonth, count: 198 });

    const tooMany = await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth, amount: 5 });
    assert.equal(tooMany.allowed, false);
    assert.equal(tooMany.used, 198, 'a bulk increment must be all-or-nothing');

    const fits = await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth, amount: 2 });
    assert.equal(fits.allowed, true);
    assert.equal(fits.used, 200);
  });

  it('resets on a new month with no job run', async () => {
    const { business } = await createTestContext();
    const june = new Date('2026-06-15T06:00:00.000Z');
    const july = new Date('2026-07-15T06:00:00.000Z');

    await setUsage({ business: business._id, limitKey: LIMITS.documentsPerMonth, count: 200, at: june });
    const blockedInJune = await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth, at: june });
    assert.equal(blockedInJune.allowed, false);

    const allowedInJuly = await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth, at: july });
    assert.equal(allowedInJuly.allowed, true);
    assert.equal(allowedInJuly.used, 1);
    // June's row is untouched history, not mutated state.
    const juneRow = await SubscriptionUsage.findOne({ business: business._id, periodKey: '2026-06', metric: LIMITS.documentsPerMonth });
    assert.equal(juneRow.count, 200);
  });

  it('records the limit in force when the period opened', async () => {
    const { business } = await createTestContext();
    await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth });

    const row = await SubscriptionUsage.findOne({ business: business._id, metric: LIMITS.documentsPerMonth });
    assert.equal(row.limitAtTime, 200);
  });

  it('gives usage back on rollback without erasing a recorded overage', async () => {
    const { business } = await createTestContext();
    await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth, amount: 3 });
    await recordOverage({ business: business._id, limitKey: LIMITS.documentsPerMonth, amount: 1 });

    const after = await decrementUsage({ business: business._id, limitKey: LIMITS.documentsPerMonth });
    assert.equal(after.used, 3);

    const row = await SubscriptionUsage.findOne({ business: business._id, metric: LIMITS.documentsPerMonth });
    assert.equal(row.overage, 1, 'an overage that happened is a fact, not a balance');
  });

  it('never drops below zero', async () => {
    const { business } = await createTestContext();
    const result = await decrementUsage({ business: business._id, limitKey: LIMITS.documentsPerMonth, amount: 5 });
    assert.equal(result.used, 0);
  });

  it('refuses to meter a live-counted limit', async () => {
    const { business } = await createTestContext();
    await assert.rejects(
      incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.teamMembers }),
      /counted live, not metered/
    );
  });
});

describe('concurrency', () => {
  it('lands on exactly the limit when many creates race it', async () => {
    const { business } = await createTestContext();
    const entitlements = { features: {}, limits: { documents_per_month: 10 } };

    const attempts = await Promise.all(
      Array.from({ length: 50 }, () => incrementUsage({ business: business._id, entitlements, limitKey: LIMITS.documentsPerMonth }))
    );

    const allowed = attempts.filter((attempt) => attempt.allowed).length;
    assert.equal(allowed, 10, `expected exactly 10 to pass, got ${allowed}`);

    const row = await SubscriptionUsage.findOne({ business: business._id, metric: LIMITS.documentsPerMonth });
    assert.equal(row.count, 10, 'the counter must never exceed the ceiling');
  });
});

describe('offline overage (approved Decision 3)', () => {
  it('counts and flags a pushed document instead of rejecting it', async () => {
    const { business } = await createTestContext();
    await setUsage({ business: business._id, limitKey: LIMITS.documentsPerMonth, count: 200 });

    // An invoice created offline is already printed and in a customer's hands.
    const result = await incrementUsage({
      business: business._id,
      entitlements: starter,
      limitKey: LIMITS.documentsPerMonth,
      allowOverage: true
    });

    assert.equal(result.allowed, true, 'sync must never reject a document that already exists');
    assert.equal(result.overLimit, true);
    assert.equal(result.used, 201);
    assert.equal(result.overage, 1);
  });

  it('accumulates overage so the upgrade prompt has a number to show', async () => {
    const { business } = await createTestContext();
    await setUsage({ business: business._id, limitKey: LIMITS.documentsPerMonth, count: 200 });

    for (let i = 0; i < 3; i += 1) {
      await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth, allowOverage: true });
    }

    const row = await SubscriptionUsage.findOne({ business: business._id, metric: LIMITS.documentsPerMonth });
    assert.equal(row.count, 203);
    assert.equal(row.overage, 3);
  });
});

describe('live-counted limits', () => {
  it('compares a caller-supplied count, the way teamLimitService already does', async () => {
    const { business } = await createTestContext();

    const atLimit = await checkLimit({ business: business._id, entitlements: starter, limitKey: LIMITS.teamMembers, used: 1 });
    assert.equal(atLimit.allowed, false);
    assert.equal(atLimit.remaining, 0);
    assert.equal(atLimit.percent, 100);

    const roomLeft = await checkLimit({
      business: business._id,
      entitlements: { features: {}, limits: { team_members: 10 } },
      limitKey: LIMITS.teamMembers,
      used: 4
    });
    assert.equal(roomLeft.allowed, true);
    assert.equal(roomLeft.remaining, 6);
  });

  it('treats an unlimited ceiling as always allowed', async () => {
    const { business } = await createTestContext();
    const result = await checkLimit({ business: business._id, entitlements: pro, limitKey: LIMITS.businesses, used: 9999 });

    assert.equal(result.allowed, true);
    assert.equal(result.unlimited, true);
    assert.equal(result.percent, 0);
  });
});

describe('usage summary', () => {
  it('reports every limit in the catalog with its meter', async () => {
    const { business } = await createTestContext();
    await incrementUsage({ business: business._id, entitlements: starter, limitKey: LIMITS.documentsPerMonth, amount: 160 });

    const summary = await usageSummary({
      business: business._id,
      entitlements: starter,
      liveCounts: { [LIMITS.teamMembers]: 1 }
    });

    const documents = summary.find((row) => row.limitKey === LIMITS.documentsPerMonth);
    assert.equal(documents.used, 160);
    assert.equal(documents.limit, 200);
    assert.equal(documents.percent, 80, 'the 80% upgrade nudge reads this');
    assert.ok(documents.resetsAt instanceof Date);

    const members = summary.find((row) => row.limitKey === LIMITS.teamMembers);
    assert.equal(members.metered, false);
    assert.equal(members.used, 1);
    assert.equal(members.resetsAt, null);

    const storage = summary.find((row) => row.limitKey === LIMITS.storageBytes);
    assert.equal(storage.unlimited, true);
    assert.equal(storage.remaining, null);

    // Generic by construction: future metrics appear without touching the engine.
    assert.ok(summary.some((row) => row.limitKey === LIMITS.aiCreditsPerMonth));
  });
});
