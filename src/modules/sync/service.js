import { validationResult } from 'express-validator';
import { INCLUDE_DELETED } from '../../models/plugins/syncable.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { ApiError } from '../../utils/ApiError.js';
import { encodeCursor, syncHorizon } from './protocol.js';
import { PUSH_OPERATIONS, SYNC_COLLECTIONS } from './registry.js';

// (updatedAt, _id) strictly-after. The tiebreaker is what makes the ordering total, and a
// total order is what makes the cursor exact rather than "skips or repeats sometimes".
const cursorClause = (cursor) =>
  cursor
    ? [{ $or: [{ updatedAt: { $gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, _id: { $gt: cursor.id } }] }]
    : [];

// A tombstone travels as identity only. The device already holds the row; all it needs is
// "this is gone", and shipping the deleted record's fields is needless PII on the wire.
const asTombstone = (record) => ({
  _id: record._id,
  clientId: record.clientId ?? null,
  version: record.version ?? null,
  updatedAt: record.updatedAt,
  deletedAt: record.deletedAt
});

export const readPage = async ({
  collection,
  businessId,
  cursor = null,
  cursorValue = null,
  limit,
  filter = {},
  includeDeleted = true
}) => {
  const { model, projection } = SYNC_COLLECTIONS[collection];
  const query = model
    .find(
      {
        business: businessId,
        ...filter,
        // Keyset seek, never skip/limit: the index positions the scan at the cursor, so
        // page 2000 costs the same as page 1. The horizon withholds writes that may still
        // be committing (see safetyLagMs).
        updatedAt: { $lte: syncHorizon() },
        ...(cursor ? { $and: cursorClause(cursor) } : {})
      },
      projection
    )
    .sort({ updatedAt: 1, _id: 1 })
    .limit(limit + 1)
    .lean();

  // The delta stream is the only reader that wants tombstones; bootstrap is a snapshot of
  // what exists, so it leaves the plugin's tombstone filter in place.
  if (includeDeleted) query.setOptions({ [INCLUDE_DELETED]: true });

  const rows = await query;
  const hasMore = rows.length > limit;
  const records = hasMore ? rows.slice(0, limit) : rows;
  const last = records[records.length - 1];

  return {
    records: records.map((record) => (record.deletedAt ? asTombstone(record) : record)),
    // An empty page hands back the cursor it was given. Returning null there would read as
    // "start over" to a client that stores whatever it was sent, and a full re-pull of
    // 100k invoices is an expensive way to say "nothing changed".
    nextCursor: last ? encodeCursor(last, collection) : cursorValue,
    hasMore
  };
};

// The newest (updatedAt, _id) currently in a collection. A device that bootstraps takes
// this as its starting cursor: everything at or before it is either in the bootstrap
// snapshot or deliberately outside the device's window, and everything after it arrives
// through the delta pull.
export const latestCursors = async (businessId, collections) => {
  const entries = await Promise.all(
    collections.map(async (collection) => {
      const { model } = SYNC_COLLECTIONS[collection];
      // Clamped to the same horizon as readPage. A starting cursor past the horizon would
      // sit ahead of writes that are still settling, and the device would never see them.
      const newest = await model
        .findOne({ business: businessId, updatedAt: { $lte: syncHorizon() } })
        .setOptions({ [INCLUDE_DELETED]: true })
        .sort({ updatedAt: -1, _id: -1 })
        .select('updatedAt')
        .lean();

      return [collection, encodeCursor(newest, collection)];
    })
  );

  return Object.fromEntries(entries);
};

// --- push -------------------------------------------------------------------------

// Enough of an Express response for a controller to write into. Nothing here is streamed:
// every sync-eligible controller answers with res.json.
const captureResponse = () => {
  const res = {
    statusCode: 200,
    body: null,
    onFinish: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      res.onFinish?.();
      return res;
    },
    set: () => res,
    setHeader: () => res
  };

  return res;
};

// Resolves when the middleware calls next() OR answers the request itself (the idempotency
// replay path does the latter — it never calls next).
const runStep = (step, req, res) =>
  new Promise((resolve, reject) => {
    res.onFinish = resolve;
    try {
      Promise.resolve(step(req, res, (error) => (error ? reject(error) : resolve()))).catch(reject);
    } catch (error) {
      reject(error);
    }
  });

const METHOD_FOR_OP = { create: 'POST', update: 'PATCH', delete: 'DELETE' };

// The batch request itself, with this operation's body, params and idempotency key laid
// over it. Prototype-linked so the controller still sees the real user, business,
// membership, session and ip. defineProperties rather than Object.assign because `path`
// and `query` are getters on the Express request prototype and assignment throws.
const subRequest = (req, op, params) => {
  const value = (input) => ({ value: input, writable: true, configurable: true, enumerable: true });

  return Object.defineProperties(Object.create(req), {
    body: value(op.payload ?? {}),
    params: value(params),
    query: value({}),
    method: value(METHOD_FOR_OP[op.opType]),
    path: value(`/sync/${op.entity}/${op.opType}`),
    route: value(undefined),
    // The op id is the idempotency key, so a retried batch replays instead of duplicating.
    get: value((name) => (String(name).toLowerCase() === 'idempotency-key' ? op.opId : req.get(name)))
  });
};

// Anything a controller can throw has to become a per-op result, or one unexpected error
// fails the other 49 operations in the batch and the device retries all of them.
const normalizeError = (error) => {
  if (error.statusCode) return error;
  if (error.code === 11000) {
    return new ApiError(409, 'Duplicate value already exists', { code: 'DUPLICATE_KEY', keyValue: error.keyValue });
  }
  return new ApiError(500, error.message || 'Operation failed', { code: 'INTERNAL_ERROR' });
};

const failure = (op, error) => ({
  opId: op.opId,
  entity: op.entity,
  opType: op.opType,
  clientId: op.clientId ?? null,
  // A 409 is a genuine collision (duplicate number, reused idempotency key, stale version).
  // The client decides what to do; for VERSION_CONFLICT it needs the current record to rebase.
  status: error.statusCode === 409 ? 'conflict' : 'rejected',
  statusCode: error.statusCode || 500,
  code: error.details?.code || null,
  message: error.message,
  details: Array.isArray(error.details) ? error.details : null,
  version: error.details?.currentVersion ?? null,
  record: error.details?.record ?? null
});

const success = (op, record, extra = {}) => ({
  opId: op.opId,
  entity: op.entity,
  opType: op.opType,
  clientId: op.clientId ?? null,
  status: 'ok',
  serverId: record?._id ? String(record._id) : op.targetId ?? null,
  version: record?.version ?? null,
  serverUpdatedAt: record?.updatedAt ?? null,
  record: record ?? null,
  ...extra
});

const runOperation = async (req, op, permissions) => {
  const definition = PUSH_OPERATIONS[`${op.entity}:${op.opType}`];

  if (!definition) {
    throw new ApiError(422, `Unsupported operation ${op.entity}:${op.opType}`, { code: 'UNSUPPORTED_OPERATION' });
  }

  // Permissions are resolved once for the batch, but re-checked per op: a device's cached
  // RBAC only gates its UI, and the server never trusts it.
  if (!permissions.includes(definition.permission)) {
    throw new ApiError(403, 'You do not have permission to perform this action', {
      code: 'FORBIDDEN_PERMISSION',
      requiredPermissions: [definition.permission]
    });
  }

  if (definition.requiresTarget && !op.targetId) {
    throw new ApiError(422, `${op.opType} requires targetId`, { code: 'TARGET_ID_REQUIRED' });
  }

  // Optimistic concurrency. Older clients omit baseVersion and keep last-write-wins;
  // current clients send the version their edit was based on and get a 409 on mismatch.
  // The full record travels with the 409 so Keep Local can rebase without a separate GET.
  if (op.opType === 'update' && op.baseVersion != null && op.targetId) {
    const current = await definition.model.findOne({ _id: op.targetId, business: req.business._id }).lean();

    if (current && current.version != null && Number(current.version) !== Number(op.baseVersion)) {
      const record = { ...current };
      // Same redaction as the pull projection: never hand bearer credentials to the device.
      delete record.shareToken;
      delete record.pdfCacheKey;

      throw new ApiError(409, 'This record changed since your last edit', {
        code: 'VERSION_CONFLICT',
        currentVersion: current.version,
        baseVersion: op.baseVersion,
        record
      });
    }
  }

  // Echo matching: the device minted this id, so a create whose response was lost to a
  // network drop returns the record it already made instead of a second one.
  if (op.opType === 'create' && op.clientId) {
    const existing = await definition.model
      .findOne({ business: req.business._id, clientId: op.clientId })
      .setOptions({ [INCLUDE_DELETED]: true })
      .lean();

    if (existing) return success(op, existing, { duplicate: true });
  }

  const params = definition.params ? definition.params(op) : {};
  const subReq = subRequest(req, op, params);

  if (definition.rules?.length) {
    await Promise.all(definition.rules.map((rule) => rule.run(subReq)));
    const errors = validationResult(subReq);
    if (!errors.isEmpty()) {
      throw new ApiError(422, 'Validation failed', errors.array());
    }
  }

  // Anything that must hold *before* the write, once the payload's shape is known good.
  // Today that is the invoice-number guard: a number a device minted offline is untrusted
  // input on a legally-binding field, checked against that device's series before the
  // document exists.
  const claim = definition.before ? await definition.before(req, op) : null;

  const res = captureResponse();
  await runStep(idempotency(), subReq, res);

  // The idempotency middleware answered from its replay record; the controller must not run.
  if (res.body === null) {
    await runStep(definition.handler, subReq, res);
  }

  if (res.statusCode >= 400) {
    throw new ApiError(res.statusCode, res.body?.message || 'Operation failed', res.body?.details || null);
  }

  const record = definition.resultKey ? res.body?.[definition.resultKey] ?? null : null;

  // Stamp the device's id onto the new record so the next pull can be matched to the local
  // row. Written through the driver rather than the model on purpose: the syncable hooks
  // would bump `version` and `updatedAt` for what is bookkeeping, not an edit.
  if (op.opType === 'create' && op.clientId && record?._id) {
    await definition.model.collection.updateOne({ _id: record._id }, { $set: { clientId: op.clientId } });
    record.clientId = op.clientId;
  }

  // Only now is the number safely on a written document, so only now is the series position
  // burned. Advancing before the write would leave a gap every time a create failed.
  if (definition.after) await definition.after(req, record, claim);

  return success(op, record);
};

// A batch is not one transaction — 47 ok, 2 conflicts and 1 rejection is a valid answer.
// Each operation is individually transactional inside the controller it routes to.
//
// ponytail: operations run one at a time. Ordering within a batch is the client's declared
// intent (a payment after the invoice it settles), and serial execution honours it for
// free. Parallelise per independent chain only if push latency measurably hurts.
export const executePush = async (req, ops, permissions) => {
  const results = [];

  for (const op of ops) {
    try {
      results.push(await runOperation(req, op, permissions));
    } catch (error) {
      results.push(failure(op, normalizeError(error)));
    }
  }

  return results;
};
