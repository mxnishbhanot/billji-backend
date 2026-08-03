import SubscriptionUsage from '../models/SubscriptionUsage.js';
import { ALL_LIMIT_KEYS, UNLIMITED, limitDefinition } from '../constants/entitlements.js';
import { getLimit, isUnlimited } from './entitlementService.js';

// LIMIT / USAGE ENGINE.
//
// Fully generic: the engine never mentions documents, seats or storage. It reads a limit
// definition from the catalog, buckets by period, and compares a count to a ceiling. Metering
// `api_calls_per_month` or `ai_credits_per_month` later needs a catalog entry and nothing else.
//
// Two kinds of limit, decided by LIMIT_DEFINITIONS[].metered:
//   metered: true   -> a counter row here (a flow: documents issued, exports run, bytes stored)
//   metered: false  -> counted live against the real collection by the caller (a point-in-time
//                      fact: how many team members exist). Cannot drift, so gets no counter.

// Quota months follow the customer's calendar, not the server's. A shop billing at 00:30 IST on
// the 1st must land in the new month, which UTC bucketing would put in the old one. India-only
// product, no DST, so a fixed offset is correct and deterministic regardless of server TZ.
// ponytail: fixed +05:30. Per-business timezones would need a real tz library — add only if
// BillJi ships outside India.
const BUSINESS_UTC_OFFSET_MINUTES = 330;

export const ALL_TIME = 'all_time';

/** 'YYYY-MM' in business time. Every monthly metric shares one key, so one query covers them all. */
export const monthKeyFor = (date = new Date()) => {
  const shifted = new Date(date.getTime() + BUSINESS_UTC_OFFSET_MINUTES * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** 'YYYY-MM' for monthly limits, 'all_time' for the rest. A new key IS the monthly reset. */
export const periodKeyFor = (limitKey, date = new Date()) => {
  const definition = limitDefinition(limitKey);
  if (!definition) throw new Error(`Unknown limit key: ${limitKey}. Add it to constants/entitlements.js.`);
  return definition.period === 'month' ? monthKeyFor(date) : ALL_TIME;
};

/** First instant of the next period — what the client shows as "resets on". null = never resets. */
export const periodResetsAt = (limitKey, date = new Date()) => {
  const definition = limitDefinition(limitKey);
  if (definition?.period !== 'month') return null;

  const shifted = new Date(date.getTime() + BUSINESS_UTC_OFFSET_MINUTES * 60 * 1000);
  const nextMonthStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return new Date(nextMonthStart - BUSINESS_UTC_OFFSET_MINUTES * 60 * 1000);
};

const assertMetered = (limitKey) => {
  const definition = limitDefinition(limitKey);
  if (!definition) throw new Error(`Unknown limit key: ${limitKey}`);
  if (!definition.metered) {
    throw new Error(`Limit ${limitKey} is counted live, not metered. Pass the current count to checkLimit().`);
  }
  return definition;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const currentUsage = async ({ business, limitKey, at = new Date() }) => {
  const row = await SubscriptionUsage.findOne({ business, periodKey: periodKeyFor(limitKey, at), metric: limitKey });
  return { count: row?.count || 0, overage: row?.overage || 0, row };
};

/**
 * Answers "is there room for `amount` more?" without writing anything.
 *
 * For metered limits the count comes from the counter row; for live-counted limits the caller
 * passes `used` (teamLimitService already does exactly this with countDocuments).
 */
export const checkLimit = async ({ business, entitlements, limitKey, amount = 1, used = null, at = new Date() }) => {
  const limit = getLimit(entitlements, limitKey);
  const unlimited = isUnlimited(limit);
  const count = used !== null ? used : (await currentUsage({ business, limitKey, at })).count;
  const remaining = unlimited ? Infinity : Math.max(0, limit - count);

  return {
    allowed: unlimited || count + amount <= limit,
    unlimited,
    limit: unlimited ? UNLIMITED : limit,
    used: count,
    remaining,
    percent: unlimited || limit === 0 ? 0 : Math.min(100, Math.round((count / limit) * 100)),
    limitKey,
    periodKey: periodKeyFor(limitKey, at),
    resetsAt: periodResetsAt(limitKey, at)
  };
};

/** Every limit in one call, for GET /billing/usage and the mobile meters. */
export const usageSummary = async ({ business, entitlements, liveCounts = {}, at = new Date() }) => {
  const rows = await SubscriptionUsage.find({ business, periodKey: { $in: [monthKeyFor(at), ALL_TIME] } });
  const byMetric = new Map(rows.map((row) => [row.metric, row]));

  return ALL_LIMIT_KEYS.map((limitKey) => {
    const definition = limitDefinition(limitKey);
    const limit = getLimit(entitlements, limitKey);
    const unlimited = isUnlimited(limit);
    const used = definition.metered ? byMetric.get(limitKey)?.count || 0 : liveCounts[limitKey] || 0;

    return {
      limitKey,
      label: definition.label,
      unit: definition.unit,
      metered: definition.metered,
      unlimited,
      limit: unlimited ? UNLIMITED : limit,
      used,
      remaining: unlimited ? null : Math.max(0, limit - used),
      percent: unlimited || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100)),
      overage: byMetric.get(limitKey)?.overage || 0,
      resetsAt: periodResetsAt(limitKey, at)
    };
  });
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Atomically consumes `amount` of a metered limit. Returns { allowed, ... } and increments only
 * when allowed.
 *
 * The check and the increment are ONE operation, deliberately. A read-then-write would let two
 * concurrent invoice creates both see 199/200 and both succeed. The `count: { $lte: limit - amount }`
 * predicate plus the unique index on (business, periodKey, metric) is what makes this safe: when
 * the row exists and is at the ceiling, the predicate misses, the upsert tries to insert, and the
 * unique index turns it into E11000 — which means "already at the limit", not an error to surface.
 *
 * Same idiom as scheduler.claimJob() and NumberSequence, both already proven in this codebase.
 */
export const incrementUsage = async ({ business, entitlements, limitKey, amount = 1, at = new Date(), allowOverage = false }) => {
  assertMetered(limitKey);
  const limit = getLimit(entitlements, limitKey);
  const unlimited = isUnlimited(limit);
  const periodKey = periodKeyFor(limitKey, at);
  const base = { business, periodKey, metric: limitKey };

  if (unlimited) {
    const row = await SubscriptionUsage.findOneAndUpdate(
      base,
      { $inc: { count: amount }, $set: { lastAt: at, limitAtTime: UNLIMITED }, $setOnInsert: base },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return { allowed: true, unlimited: true, limit: UNLIMITED, used: row.count, remaining: Infinity, overage: row.overage, limitKey, periodKey };
  }

  try {
    const row = await SubscriptionUsage.findOneAndUpdate(
      { ...base, count: { $lte: limit - amount } },
      { $inc: { count: amount }, $set: { lastAt: at, limitAtTime: limit }, $setOnInsert: base },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return { allowed: true, unlimited: false, limit, used: row.count, remaining: Math.max(0, limit - row.count), overage: row.overage, limitKey, periodKey };
  } catch (error) {
    if (error?.code !== 11000) throw error;

    // Row exists and is at the ceiling. Either refuse, or accept and flag the overage.
    if (!allowOverage) {
      const { count, overage } = await currentUsage({ business, limitKey, at });
      return { allowed: false, unlimited: false, limit, used: count, remaining: Math.max(0, limit - count), overage, limitKey, periodKey };
    }

    return recordOverage({ business, limitKey, amount, limit, at });
  }
};

/**
 * Counts usage past the ceiling instead of refusing it.
 *
 * Exists for one reason (approved Decision 3): an invoice created offline is already printed and
 * in a customer's hands with a number on it. Rejecting it at sync time would corrupt the number
 * sequence and destroy trust. So the sync path counts, flags, and prompts an upgrade — it never
 * rejects. Interactive online creation still enforces the ceiling.
 */
export const recordOverage = async ({ business, limitKey, amount = 1, limit = null, at = new Date() }) => {
  assertMetered(limitKey);
  const periodKey = periodKeyFor(limitKey, at);
  const base = { business, periodKey, metric: limitKey };

  const row = await SubscriptionUsage.findOneAndUpdate(
    base,
    { $inc: { count: amount, overage: amount }, $set: { lastAt: at, ...(limit === null ? {} : { limitAtTime: limit }) }, $setOnInsert: base },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return {
    allowed: true,
    overLimit: true,
    unlimited: false,
    limit: limit ?? row.limitAtTime ?? UNLIMITED,
    used: row.count,
    remaining: 0,
    overage: row.overage,
    limitKey,
    periodKey
  };
};

/**
 * Gives usage back. Called when the operation the usage was consumed for is rolled back — a
 * failed transaction, a deleted draft. Never drops below zero, and does not touch `overage`:
 * an overage that happened is a fact, not a balance.
 */
export const decrementUsage = async ({ business, limitKey, amount = 1, at = new Date() }) => {
  assertMetered(limitKey);
  const row = await SubscriptionUsage.findOneAndUpdate(
    { business, periodKey: periodKeyFor(limitKey, at), metric: limitKey, count: { $gte: amount } },
    { $inc: { count: -amount }, $set: { lastAt: at } },
    { new: true }
  );
  return { used: row?.count || 0 };
};

export const remainingUsage = async ({ business, entitlements, limitKey, used = null, at = new Date() }) => {
  const result = await checkLimit({ business, entitlements, limitKey, amount: 0, used, at });
  return result.unlimited ? Infinity : result.remaining;
};

/** Seeds a counter to a known value. Used by the P7 backfill so day-one meters are honest. */
export const setUsage = async ({ business, limitKey, count, limit = null, at = new Date() }) => {
  assertMetered(limitKey);
  const periodKey = periodKeyFor(limitKey, at);

  return SubscriptionUsage.findOneAndUpdate(
    { business, periodKey, metric: limitKey },
    { $set: { count, lastAt: at, ...(limit === null ? {} : { limitAtTime: limit }) }, $setOnInsert: { business, periodKey, metric: limitKey } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};
