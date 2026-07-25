import crypto from 'crypto';
import DataExport from '../../models/DataExport.js';
import User from '../../models/User.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../../services/eventBus.js';
import { sendDataExportReadyEmail } from '../../services/emailService.js';
import { upsertNotification } from '../../services/notificationService.js';
import { emitBusinessEvent } from '../../services/socketService.js';
import { deleteObject, getSignedObjectUrl, isR2Enabled, putObject } from '../../services/r2Service.js';
import { buildExportArchive } from './archive.js';

// One export per business per hour. Building an archive walks every collection, so this
// is both an abuse guard and a cost guard. No new rate limiter needed — the existing
// rows are the state.
const COOLDOWN_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 7;
// Download links live as long as the archive; the presigned URL behind the redirect is
// short-lived and minted per request.
const DOWNLOAD_TTL_SECONDS = 300;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const publicDownloadUrl = (row, token) =>
  `${String(env.apiPublicUrl).replace(/\/+$/, '')}/api/public/exports/${row._id}/${token}`;

const objectKeyFor = (businessId, exportId) => `exports/${businessId}/${exportId}.zip`;

const fileNameFor = (business, generatedAt) => {
  const slug = String(business?.businessName || 'billji')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'billji';
  return `${slug}-export-${generatedAt.toISOString().slice(0, 10)}.zip`;
};

export const serializeDataExport = (row) => {
  const data = row.toObject ? row.toObject() : row;
  return {
    id: String(data._id),
    status: data.status,
    fileName: data.fileName || '',
    sizeBytes: data.sizeBytes || 0,
    counts: data.counts || {},
    requestedAt: data.createdAt,
    completedAt: data.completedAt || null,
    expiresAt: data.expiresAt || null,
    // Null when the send failed or Resend is unconfigured, so the UI can stop claiming
    // a link was emailed.
    emailedAt: data.emailedAt || null,
    downloadCount: data.downloadCount || 0,
    // Never expose objectKey or tokenHash.
    isExpired: Boolean(data.expiresAt && data.expiresAt.getTime() < Date.now()),
    error: data.status === 'failed' ? data.error || 'Export failed' : ''
  };
};

export const listExports = async (businessId, { limit = 10 } = {}) =>
  DataExport.find({ business: businessId }).sort({ createdAt: -1 }).limit(limit);

export const getExportForBusiness = async (businessId, exportId) => {
  const row = await DataExport.findOne({ _id: exportId, business: businessId });
  if (!row) throw new ApiError(404, 'Export not found');
  return row;
};

/**
 * Queues an export. Returns immediately; the outbox dispatcher does the work.
 */
export const requestExport = async ({ business, user }) => {
  if (!isR2Enabled()) {
    throw new ApiError(503, 'Data export storage is not configured. Contact support.');
  }

  const inFlight = await DataExport.findOne({
    business: business._id,
    status: { $in: ['queued', 'processing'] }
  });
  if (inFlight) {
    throw new ApiError(429, 'An export is already being prepared. It will be ready shortly.', {
      code: 'EXPORT_IN_PROGRESS',
      exportId: String(inFlight._id)
    });
  }

  const recent = await DataExport.findOne({
    business: business._id,
    status: 'completed',
    completedAt: { $gte: new Date(Date.now() - COOLDOWN_MS) }
  }).sort({ completedAt: -1 });
  if (recent) {
    throw new ApiError(429, 'You can request a new export once an hour. Your latest export is still available.', {
      code: 'EXPORT_COOLDOWN',
      exportId: String(recent._id),
      retryAfter: Math.ceil((recent.completedAt.getTime() + COOLDOWN_MS - Date.now()) / 1000)
    });
  }

  const row = await DataExport.create({
    business: business._id,
    requestedBy: user._id,
    status: 'queued'
  });

  await publishDomainEvent({
    business: business._id,
    actor: user._id,
    eventType: DOMAIN_EVENTS.dataExportRequested,
    aggregateType: 'data_export',
    aggregateId: row._id
  });

  emitBusinessEvent(business._id, 'exports:changed', { reason: 'requested' });

  return row;
};

// Drops the archive for a superseded export so storage stays bounded at one live
// archive per business.
const discardPrevious = async (businessId, keepId) => {
  const stale = await DataExport.find({
    business: businessId,
    _id: { $ne: keepId },
    objectKey: { $ne: '' }
  });

  for (const row of stale) {
    try {
      await deleteObject(row.objectKey);
    } catch {
      // Best effort — an orphaned object is swept by the R2 lifecycle rule on exports/.
    }
    row.objectKey = '';
    row.tokenHash = '';
    row.expiresAt = new Date(0);
    await row.save();
  }
};

const notifyReady = async (row, business) => {
  await upsertNotification({
    business: business._id,
    actor: row.requestedBy,
    notificationId: `data-export:${row._id}`,
    type: 'data-export-ready',
    resourceType: 'data_export',
    resourceId: row._id,
    tone: 'info',
    title: 'Your data export is ready',
    description: `${(row.sizeBytes / (1024 * 1024)).toFixed(1)} MB. The download link expires in ${RETENTION_DAYS} days.`,
    to: '/settings/data-export',
    sortDate: row.completedAt || new Date()
  });

  emitBusinessEvent(business._id, 'exports:changed', { reason: 'completed' });
  emitBusinessEvent(business._id, 'notifications:changed', { reason: 'data-export-ready' });
};

/**
 * Builds, stores and announces one export.
 *
 * Idempotent by design: the object key is derived from the export id, so a dispatcher
 * retry overwrites the same object and rewrites the same row. Throwing lets the outbox
 * retry with its own backoff.
 *
 * ponytail: runs inside the outbox dispatcher's sequential loop, so a long export delays
 * notification projection for its duration. Fine for a seconds-long CSV/JSON build; move
 * to a dedicated worker if exports start taking tens of seconds.
 */
export const runDataExport = async (exportId) => {
  const row = await DataExport.findById(exportId);
  if (!row) return null;
  if (row.status === 'completed') return row;

  row.status = 'processing';
  row.startedAt = new Date();
  row.error = '';
  await row.save();

  try {
    const { buffer, counts, generatedAt, business } = await buildExportArchive(row.business);

    const objectKey = objectKeyFor(row.business, row._id);
    const stored = await putObject(objectKey, buffer, { contentType: 'application/zip' });
    if (!stored) throw new Error('Export storage is not configured');

    const token = crypto.randomBytes(24).toString('hex');

    row.status = 'completed';
    row.objectKey = objectKey;
    row.fileName = fileNameFor(business, generatedAt);
    row.sizeBytes = buffer.length;
    row.counts = counts;
    row.tokenHash = hashToken(token);
    row.completedAt = new Date();
    row.expiresAt = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await row.save();

    await discardPrevious(row.business, row._id);
    await notifyReady(row, business);

    // Email is a convenience on top of the in-app download; never fail the job for it.
    try {
      const requester = row.requestedBy ? await User.findById(row.requestedBy).lean() : null;
      if (requester?.email) {
        await sendDataExportReadyEmail({
          to: requester.email,
          name: requester.name,
          business,
          downloadUrl: publicDownloadUrl(row, token),
          sizeBytes: row.sizeBytes,
          expiresAt: row.expiresAt
        });
        row.emailedAt = new Date();
        await row.save();
      }
    } catch (error) {
      console.error('Data export email failed:', error.message);
    }

    return row;
  } catch (error) {
    row.status = 'failed';
    row.error = error.message || 'Export failed';
    await row.save();
    emitBusinessEvent(row.business, 'exports:changed', { reason: 'failed' });
    throw error;
  }
};

const assertDownloadable = (row) => {
  if (row.status !== 'completed' || !row.objectKey) {
    throw new ApiError(409, 'This export is not ready to download');
  }
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    throw new ApiError(410, 'This export has expired. Request a new one from Settings.');
  }
};

// Mints a short-lived presigned URL and records the download. Shared by the
// authenticated in-app route and the tokenised email route so the expiry, the
// Content-Disposition filename and the counter can only be got right in one place.
const resolveDownload = async (row) => {
  assertDownloadable(row);

  const url = await getSignedObjectUrl(row.objectKey, {
    expiresIn: DOWNLOAD_TTL_SECONDS,
    fileName: row.fileName
  });
  if (!url) throw new ApiError(503, 'Export storage is not configured');

  row.downloadCount += 1;
  row.lastDownloadedAt = new Date();
  await row.save();

  return url;
};

export const resolveDownloadForBusiness = async (businessId, exportId) => {
  const row = await getExportForBusiness(businessId, exportId);
  return { url: await resolveDownload(row), row };
};

/** Email-link path: the raw token stands in for authentication. */
export const resolveDownloadByToken = async (exportId, token) => {
  const row = await DataExport.findOne({ _id: exportId, tokenHash: hashToken(token || '') });
  if (!row) throw new ApiError(404, 'Export link is invalid or has been replaced');
  return { url: await resolveDownload(row), row };
};
