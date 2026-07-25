import { asyncHandler } from '../../utils/asyncHandler.js';
import { logAudit } from '../../services/auditService.js';
import {
  getExportForBusiness,
  listExports,
  requestExport,
  resolveDownloadByToken,
  resolveDownloadForBusiness,
  serializeDataExport
} from './service.js';

export const createExport = asyncHandler(async (req, res) => {
  const row = await requestExport({ business: req.business, user: req.user });

  void logAudit(req, {
    action: 'data_export.requested',
    resourceType: 'data_export',
    resourceId: row._id
  });

  res.status(202).json(serializeDataExport(row));
});

export const getExports = asyncHandler(async (req, res) => {
  const rows = await listExports(req.business._id);
  res.json(rows.map(serializeDataExport));
});

export const getExport = asyncHandler(async (req, res) => {
  const row = await getExportForBusiness(req.business._id, req.params.id);
  res.json(serializeDataExport(row));
});

// The archive never passes through the API process; the client fetches it straight from
// object storage with a short-lived presigned URL.
export const getExportDownloadUrl = asyncHandler(async (req, res) => {
  const { url, row } = await resolveDownloadForBusiness(req.business._id, req.params.id);

  void logAudit(req, {
    action: 'data_export.downloaded',
    resourceType: 'data_export',
    resourceId: row._id
  });

  res.json({ url, fileName: row.fileName, sizeBytes: row.sizeBytes });
});

// Unauthenticated: reached from the emailed link, where the opaque token in the path is
// the only credential. Nothing is echoed back but the redirect.
export const publicExportDownload = asyncHandler(async (req, res) => {
  const { url, row } = await resolveDownloadByToken(req.params.id, req.params.token);

  void logAudit(req, {
    action: 'data_export.downloaded',
    resourceType: 'data_export',
    resourceId: row._id,
    metadata: { via: 'email_link' },
    business: row.business
  });

  res.redirect(302, url);
});
