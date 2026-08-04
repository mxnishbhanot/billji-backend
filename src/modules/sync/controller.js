import { permissionsForMembership } from '../../middlewares/authorization.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  DEFAULT_PULL_LIMIT,
  MAX_PUSH_BYTES,
  MAX_PUSH_OPERATIONS,
  SUPPORTED_SYNC_PROTOCOL_VERSIONS,
  SYNC_FEATURE_FLAGS,
  SYNC_LIMITS,
  SYNC_PROTOCOL_VERSION,
  decodeCursor
} from './protocol.js';
import { registerDevice } from './deviceRegistry.js';
import { BOOTSTRAP_PHASE_1, SYNC_COLLECTIONS, SYNC_COLLECTION_NAMES, bootstrapPhase2 } from './registry.js';
import { executePush, latestCursors, readPage } from './service.js';

const permissionsFor = (req) => req.permissions ?? permissionsForMembership(req.membership);

const readableCollections = (permissions) =>
  SYNC_COLLECTION_NAMES.filter((name) => permissions.includes(SYNC_COLLECTIONS[name].permission));

// Rejected whole rather than truncated: dropping the tail of an oversized batch loses the
// user's work with nothing to show them.
export const enforceBatchSize = (req, _res, next) => {
  if (Number(req.get('content-length') || 0) > MAX_PUSH_BYTES) {
    return next(
      new ApiError(413, 'Sync batch exceeds the maximum request size', {
        code: 'SYNC_BATCH_TOO_LARGE',
        maxBytes: MAX_PUSH_BYTES,
        maxOperations: MAX_PUSH_OPERATIONS
      })
    );
  }

  return next();
};

export const pushChanges = asyncHandler(async (req, res) => {
  const permissions = await permissionsFor(req);
  // Authenticated and authorised once for the whole batch: the per-request auth cost is
  // what makes one-op-per-request unaffordable at 500 queued operations.
  const results = await executePush(req, req.body.ops, permissions);

  res.json({
    success: true,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    results,
    summary: {
      ok: results.filter((result) => result.status === 'ok').length,
      conflict: results.filter((result) => result.status === 'conflict').length,
      rejected: results.filter((result) => result.status === 'rejected').length
    }
  });
});

export const pullChanges = asyncHandler(async (req, res) => {
  const permissions = await permissionsFor(req);
  const collection = req.query.collection;

  if (!permissions.includes(SYNC_COLLECTIONS[collection].permission)) {
    throw new ApiError(403, 'You do not have permission to read this collection', {
      code: 'FORBIDDEN_PERMISSION',
      requiredPermissions: [SYNC_COLLECTIONS[collection].permission]
    });
  }

  const page = await readPage({
    collection,
    businessId: req.business._id,
    cursor: decodeCursor(req.query.cursor, collection),
    cursorValue: req.query.cursor || null,
    limit: req.query.limit || DEFAULT_PULL_LIMIT
  });

  res.json({
    success: true,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    collection,
    // No total count: a delta stream is drained until hasMore is false, and counting the
    // remainder of a 100k collection on every page is pure waste.
    ...page
  });
});

export const bootstrap = asyncHandler(async (req, res) => {
  const permissions = await permissionsFor(req);
  const scope = req.query.scope || 'phase1';
  const limit = req.query.limit || DEFAULT_PULL_LIMIT;

  const since = new Date();
  since.setMonth(since.getMonth() - (req.query.months || 12));
  const filters = scope === 'phase2' ? bootstrapPhase2(since) : BOOTSTRAP_PHASE_1;

  const allowed = readableCollections(permissions).filter((name) => name in filters);
  const requested = req.query.collection ? allowed.filter((name) => name === req.query.collection) : allowed;

  if (req.query.collection && !requested.length) {
    throw new ApiError(403, 'You do not have permission to read this collection', {
      code: 'FORBIDDEN_PERMISSION'
    });
  }

  // One cursor cannot resume several collections at once — each has its own clock. A
  // continuation must name the collection it continues.
  if (req.query.cursor && !req.query.collection) {
    throw new ApiError(400, 'A bootstrap cursor requires the collection it belongs to', {
      code: 'CURSOR_COLLECTION_REQUIRED'
    });
  }

  // Cursors are captured before the snapshot reads, never after: a record changed while
  // bootstrap runs is then re-delivered by the delta pull instead of being missed.
  const cursors = await latestCursors(req.business._id, readableCollections(permissions));

  const pages = await Promise.all(
    requested.map(async (name) => [
      name,
      await readPage({
        collection: name,
        businessId: req.business._id,
        cursor: decodeCursor(req.query.cursor, name),
        cursorValue: req.query.cursor || null,
        limit,
        filter: filters[name],
        includeDeleted: false
      })
    ])
  );

  res.json({
    success: true,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    scope,
    businessId: req.business._id,
    // Settings and the effective permission set: an invoice cannot be rendered or a screen
    // gated without them, so they ship in the blocking phase.
    business: req.business,
    permissions,
    featureFlags: SYNC_FEATURE_FLAGS,
    // Where the delta pull starts once bootstrap has drained. Anything older than the
    // bootstrap window is deliberately not on the device and is fetched on demand.
    cursors,
    collections: Object.fromEntries(pages)
  });
});

/**
 * Allocates (or returns) this device's numbering series.
 *
 * Called once at setup and again on every sync, because the reply carries the series'
 * current position: device 1 shares the business's existing sequence with the web app, so
 * re-reading it is what stops an offline number colliding with one issued online while the
 * device was away.
 */
export const registerSyncDevice = asyncHandler(async (req, res) => {
  const { series } = await registerDevice({
    business: req.business,
    user: req.user,
    // The header is the same device identity every other sync request carries.
    deviceId: req.deviceId || req.body.deviceId,
    name: req.body.name,
    platform: req.body.platform,
    documentType: req.body.documentType || 'invoice'
  });

  res.json({
    success: true,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    series
  });
});

export const syncStatus = asyncHandler(async (req, res) => {
  const permissions = await permissionsFor(req);
  const cursors = await latestCursors(req.business._id, readableCollections(permissions));

  res.json({
    success: true,
    serverTime: new Date().toISOString(),
    protocolVersion: SYNC_PROTOCOL_VERSION,
    supportedProtocolVersions: SUPPORTED_SYNC_PROTOCOL_VERSIONS,
    businessId: req.business._id,
    deviceId: req.deviceId || null,
    cursors,
    featureFlags: SYNC_FEATURE_FLAGS,
    limits: SYNC_LIMITS
  });
});
