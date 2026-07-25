import mongoose from 'mongoose';

export const DATA_EXPORT_STATUSES = ['queued', 'processing', 'completed', 'failed'];

// One requested archive of a business's data. Built asynchronously by the outbox
// dispatcher (modules/exports/service.js) and stored in R2.
//
// Deliberately NOT TTL-indexed: a TTL would delete the row while the R2 object lives on,
// leaving an orphaned archive with no expiry check in front of it. Retention is enforced
// by the explicit expiresAt check on download, plus an R2 lifecycle rule on the
// `exports/` prefix. Rows are small and their history is useful in support.
const dataExportSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    status: { type: String, enum: DATA_EXPORT_STATUSES, default: 'queued', index: true },
    objectKey: { type: String, default: '' },
    fileName: { type: String, default: '' },
    sizeBytes: { type: Number, default: 0 },
    // Row count per file, straight from the archive manifest.
    counts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    // SHA-256 of the download token. The raw token only ever exists in the email link,
    // mirroring BusinessInvitation/PasswordResetToken — a leaked DB must not yield a
    // working link to the business's entire book of record.
    tokenHash: { type: String, default: '', index: true },
    expiresAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    emailedAt: { type: Date, default: null },
    downloadCount: { type: Number, default: 0 },
    lastDownloadedAt: { type: Date, default: null },
    error: { type: String, default: '' }
  },
  { timestamps: true }
);

dataExportSchema.index({ business: 1, createdAt: -1 });

const DataExport = mongoose.models.DataExport || mongoose.model('DataExport', dataExportSchema);

export default DataExport;
