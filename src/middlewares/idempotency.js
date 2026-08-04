import crypto from 'crypto';
import { IDEMPOTENCY_HEADER } from '../contracts/phase0Architecture.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import { ApiError } from '../utils/ApiError.js';

const LOCK_TIMEOUT_MS = 60 * 1000;
// Retention has to outlive the longest window a device can stay offline, or a key expires
// before the operation it protects is ever pushed and the replay turns into a duplicate.
// The architecture puts that window at 30 days, so retention matches it.
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Matches the model's maxlength. A longer key is a client bug; rejecting it here turns a
// Mongoose ValidationError (500) into an honest 400.
const MAX_KEY_LENGTH = 180;

// Told to the client on an in-progress collision so a retry backs off instead of hot-looping.
const RETRY_AFTER_SECONDS = 1;

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const requestHash = (req) =>
  crypto
    .createHash('sha256')
    .update(stableStringify({ method: req.method, path: req.route?.path || req.path, params: req.params || {}, body: req.body || {} }))
    .digest('hex');

const finishIdempotencyRecord = (recordId, statusCode, body) => {
  const isSuccess = statusCode < 500;
  return IdempotencyKey.findByIdAndUpdate(recordId, {
    $set: {
      // A 5xx is not a final answer — it is stored as `failed` so the next attempt with the
      // same key re-executes rather than replaying a server error forever.
      status: isSuccess ? 'completed' : 'failed',
      responseStatus: statusCode,
      responseBody: isSuccess ? body : null,
      completedAt: new Date()
    }
  }).catch(() => {});
};

const replay = (res, record) => {
  res.set('Idempotency-Replayed', 'true');
  return res.status(record.responseStatus || 200).json(record.responseBody);
};

// A record that is finished replays. A record still held by a live lock is a genuine
// concurrent retry. A record whose lock has gone stale (the process died mid-write) is
// reclaimed — but only by one caller: the compare-and-set on `lockedAt` is what stops two
// simultaneous retries from both deciding the lock is theirs and both executing the write.
const claimExistingRecord = async (record, hash, res) => {
  if (record.requestHash !== hash) {
    throw new ApiError(409, 'Idempotency key was already used for a different request', {
      code: 'IDEMPOTENCY_KEY_REUSED'
    });
  }

  if (record.status === 'completed') {
    return { replay: true, record };
  }

  const lockAge = Date.now() - new Date(record.lockedAt).getTime();
  if (record.status === 'processing' && lockAge < LOCK_TIMEOUT_MS) {
    res.set('Retry-After', String(RETRY_AFTER_SECONDS));
    throw new ApiError(409, 'A request with this idempotency key is still processing', {
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      retryAfterSeconds: RETRY_AFTER_SECONDS
    });
  }

  const reclaimed = await IdempotencyKey.findOneAndUpdate(
    { _id: record._id, status: { $in: ['processing', 'failed'] }, lockedAt: record.lockedAt },
    { $set: { status: 'processing', lockedAt: new Date(), responseStatus: null, responseBody: null, completedAt: null } },
    { new: true }
  );

  if (!reclaimed) {
    // Another retry won the reclaim in the moment between our read and our write.
    res.set('Retry-After', String(RETRY_AFTER_SECONDS));
    throw new ApiError(409, 'A request with this idempotency key is still processing', {
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      retryAfterSeconds: RETRY_AFTER_SECONDS
    });
  }

  return { replay: false, record: reclaimed };
};

export const idempotency = () => async (req, res, next) => {
  try {
    const key = (req.get(IDEMPOTENCY_HEADER) || '').trim();
    if (!key) return next();

    if (key.length > MAX_KEY_LENGTH) {
      throw new ApiError(400, `${IDEMPOTENCY_HEADER} must be ${MAX_KEY_LENGTH} characters or fewer`, {
        code: 'IDEMPOTENCY_KEY_INVALID'
      });
    }

    const hash = requestHash(req);
    let record = await IdempotencyKey.findOne({ business: req.business._id, key });

    if (record) {
      const result = await claimExistingRecord(record, hash, res);
      if (result.replay) return replay(res, result.record);
      record = result.record;
    } else {
      try {
        record = await IdempotencyKey.create({
          business: req.business._id,
          user: req.user._id,
          key,
          method: req.method,
          path: req.originalUrl,
          requestHash: hash,
          status: 'processing',
          lockedAt: new Date(),
          expiresAt: new Date(Date.now() + RETENTION_MS)
        });
      } catch (error) {
        // Two requests with the same key raced the insert; the unique index picked a winner
        // and this one re-reads the record the winner created.
        if (error.code !== 11000) throw error;
        record = await IdempotencyKey.findOne({ business: req.business._id, key });
        if (!record) {
          throw error;
        }
        const result = await claimExistingRecord(record, hash, res);
        if (result.replay) return replay(res, result.record);
        record = result.record;
      }
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // The outcome is recorded BEFORE the bytes leave. Fire-and-forget here was a real
      // duplicate-write hole: a crash between sending the response and persisting the
      // record leaves the key `processing`, and 60 seconds later the retry re-runs an
      // operation that already committed — a second invoice for one sale.
      void finishIdempotencyRecord(record._id, res.statusCode, body).then(
        () => originalJson(body),
        () => originalJson(body)
      );
      return res;
    };

    return next();
  } catch (error) {
    return next(error);
  }
};
