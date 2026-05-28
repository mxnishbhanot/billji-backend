import crypto from 'crypto';
import { IDEMPOTENCY_HEADER } from '../contracts/phase0Architecture.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import { ApiError } from '../utils/ApiError.js';

const LOCK_TIMEOUT_MS = 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

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
      status: isSuccess ? 'completed' : 'failed',
      responseStatus: statusCode,
      responseBody: isSuccess ? body : null,
      completedAt: new Date()
    }
  }).catch(() => {});
};

const handleExistingRecord = async (record, hash) => {
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
    throw new ApiError(409, 'A request with this idempotency key is still processing', {
      code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS'
    });
  }

  record.status = 'processing';
  record.lockedAt = new Date();
  record.responseStatus = null;
  record.responseBody = null;
  record.completedAt = null;
  await record.save();

  return { replay: false, record };
};

export const idempotency = () => async (req, res, next) => {
  try {
    const key = req.get(IDEMPOTENCY_HEADER);
    if (!key) return next();

    const hash = requestHash(req);
    let record = await IdempotencyKey.findOne({ business: req.business._id, key });

    if (record) {
      const result = await handleExistingRecord(record, hash);
      if (result.replay) {
        return res.status(result.record.responseStatus || 200).json(result.record.responseBody);
      }
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
        if (error.code !== 11000) throw error;
        record = await IdempotencyKey.findOne({ business: req.business._id, key });
        if (!record) {
          throw error;
        }
        const result = await handleExistingRecord(record, hash);
        if (result.replay) {
          return res.status(result.record.responseStatus || 200).json(result.record.responseBody);
        }
        record = result.record;
      }
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      void finishIdempotencyRecord(record._id, res.statusCode, body);
      return originalJson(body);
    };

    return next();
  } catch (error) {
    return next(error);
  }
};
