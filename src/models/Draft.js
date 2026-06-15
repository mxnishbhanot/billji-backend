import mongoose from 'mongoose';
import { SALES_DOCUMENT_TYPES } from './SalesDocument.js';

const draftSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    localDraftId: { type: String, required: true, trim: true, maxlength: 120 },
    documentType: { type: String, enum: SALES_DOCUMENT_TYPES, default: 'invoice', required: true, index: true },
    schemaVersion: { type: Number, default: 1, min: 1 },
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    dirty: { type: Boolean, default: false },
    lastEditedAt: { type: Date, default: Date.now, index: true },
    lastSyncedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

draftSchema.index({ business: 1, user: 1, localDraftId: 1 }, { unique: true });
draftSchema.index({ business: 1, user: 1, documentType: 1, lastEditedAt: -1 });
// Abandoned drafts expire automatically — without this they accumulate forever,
// since the client only deletes on explicit discard or document creation.
draftSchema.index({ lastEditedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const Draft = mongoose.models.Draft || mongoose.model('Draft', draftSchema);

export default Draft;
