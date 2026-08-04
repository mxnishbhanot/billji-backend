import { ApiError } from '../../utils/ApiError.js';

// The wire contract between a device and the sync API. Bumped only when the shape of a
// push op, a pull page, or a cursor changes in a way an older client cannot read.
export const SYNC_PROTOCOL_VERSION = 1;
export const SUPPORTED_SYNC_PROTOCOL_VERSIONS = [1];

export const SYNC_PROTOCOL_HEADER = 'X-Sync-Protocol-Version';
export const SYNC_DEVICE_HEADER = 'X-Device-Id';

// Hard caps, enforced server-side. A batch over the limit is rejected whole rather than
// truncated: silently dropping ops 51..80 loses a shopkeeper's work with no error to show.
export const MAX_PUSH_OPERATIONS = 50;
export const MAX_PUSH_BYTES = 1024 * 1024;

export const DEFAULT_PULL_LIMIT = 200;
export const MAX_PULL_LIMIT = 500;

// Tombstones are purged after this window, so a cursor older than it may miss deletions
// the server has already forgotten. Such a cursor is rejected and the device re-bootstraps.
export const TOMBSTONE_RETENTION_DAYS = 90;

// A delta page never returns records newer than (now - lag).
//
// Mongoose stamps `updatedAt` when the write is issued, but the document only becomes
// visible when it commits — and BillJi writes invoices, payments and stock inside
// multi-document transactions that can take a couple of hundred milliseconds. Without a
// lag, a pull can advance its cursor past a timestamp that a still-committing transaction
// is about to occupy; that record then sorts *before* the cursor forever and the device
// never sees it. Withholding the last second of writes lets them settle first. They arrive
// on the next pull, one second later — the cost of the fix is latency, and the bug it
// prevents is a permanently missing invoice.
//
// Live-read from env so a test can prove both branches; not a knob to tune in production.
export const safetyLagMs = () => Number(process.env.SYNC_SAFETY_LAG_MS ?? 1000);

export const syncHorizon = () => new Date(Date.now() - safetyLagMs());

// Static for now — there is no per-business flag store yet. The endpoint exists so the
// client can gate offline features on the server's answer from day one.
export const SYNC_FEATURE_FLAGS = {
  syncPush: true,
  syncPull: true,
  syncBootstrap: true,
  // Phases 4-6 of the offline roadmap. The client must not turn these on by itself.
  conflictResolution: false,
  deviceNumberingSeries: false
};

export const SYNC_LIMITS = {
  maxPushOperations: MAX_PUSH_OPERATIONS,
  maxPushBytes: MAX_PUSH_BYTES,
  maxPullLimit: MAX_PULL_LIMIT,
  defaultPullLimit: DEFAULT_PULL_LIMIT,
  tombstoneRetentionDays: TOMBSTONE_RETENTION_DAYS
};

// The delta cursor is the composite (updatedAt, _id). A bare timestamp is not enough:
// a bulk import writes thousands of rows in the same millisecond, and a timestamp-only
// cursor then either skips them or loops on them forever. The _id tiebreaker makes the
// ordering total, and a total order is what makes the cursor exact.
//
// Wire form: base64url("1|<collection>|<ISO updatedAt>|<ObjectId>"). Opaque to the client
// so the composite can gain a field behind the leading version tag. Not signed: it encodes
// no authority, and every query it feeds is already scoped to req.business.
const CURSOR_VERSION = '1';

export const encodeCursor = (record, collection) => {
  if (!record?.updatedAt || !record?._id) return null;
  const parts = [CURSOR_VERSION, collection, new Date(record.updatedAt).toISOString(), String(record._id)];
  return Buffer.from(parts.join('|')).toString('base64url');
};

export const decodeCursor = (value, collection) => {
  if (!value) return null;

  const [version, cursorCollection, timestamp, id] = Buffer.from(String(value), 'base64url')
    .toString('utf8')
    .split('|');
  const updatedAt = new Date(timestamp);

  if (version !== CURSOR_VERSION || !cursorCollection || !id || Number.isNaN(updatedAt.getTime())) {
    throw new ApiError(400, 'Malformed sync cursor', { code: 'CURSOR_INVALID' });
  }

  // A cursor from one collection applied to another silently skips every record older than
  // the other collection's clock. Binding the collection turns that into a loud 400.
  if (cursorCollection !== collection) {
    throw new ApiError(400, `Cursor belongs to "${cursorCollection}", not "${collection}"`, {
      code: 'CURSOR_COLLECTION_MISMATCH',
      cursorCollection,
      requestedCollection: collection
    });
  }

  // A future-dated cursor — clock skew on the device, or a hand-edited one — would skip
  // everything written between now and that timestamp, permanently.
  if (updatedAt.getTime() > Date.now()) {
    throw new ApiError(400, 'Sync cursor is dated in the future', { code: 'CURSOR_INVALID' });
  }

  const ageDays = (Date.now() - updatedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > TOMBSTONE_RETENTION_DAYS) {
    throw new ApiError(409, 'Sync cursor is older than the tombstone retention window', {
      code: 'CURSOR_EXPIRED',
      tombstoneRetentionDays: TOMBSTONE_RETENTION_DAYS
    });
  }

  return { updatedAt, id };
};

// Every sync request declares the protocol it speaks. Without this, a two-year-old install
// pushing against a changed contract fails in whatever way the payload happens to break.
export const requireSyncProtocol = (req, _res, next) => {
  const raw = req.get(SYNC_PROTOCOL_HEADER);
  const version = Number(raw);

  if (!raw || !SUPPORTED_SYNC_PROTOCOL_VERSIONS.includes(version)) {
    return next(
      new ApiError(426, `Unsupported sync protocol version. Send ${SYNC_PROTOCOL_HEADER}.`, {
        code: 'SYNC_PROTOCOL_UNSUPPORTED',
        supportedVersions: SUPPORTED_SYNC_PROTOCOL_VERSIONS,
        received: raw || null
      })
    );
  }

  req.syncProtocolVersion = version;
  req.deviceId = (req.get(SYNC_DEVICE_HEADER) || '').trim().slice(0, 64);
  return next();
};
