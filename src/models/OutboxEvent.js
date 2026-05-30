import mongoose from 'mongoose';

export const OUTBOX_EVENT_STATUSES = ['pending', 'processing', 'processed', 'failed'];

const outboxEventSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    eventType: { type: String, required: true, trim: true, maxlength: 120, index: true },
    aggregateType: { type: String, required: true, trim: true, maxlength: 80 },
    aggregateId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    status: { type: String, enum: OUTBOX_EVENT_STATUSES, default: 'pending', index: true },
    attempts: { type: Number, default: 0, min: 0 },
    availableAt: { type: Date, default: Date.now, index: true },
    lockedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    lastError: { type: String, default: '', maxlength: 2000 },
    dedupeKey: { type: String, required: true, trim: true, maxlength: 220 }
  },
  { timestamps: true }
);

outboxEventSchema.index({ business: 1, dedupeKey: 1 }, { unique: true });
outboxEventSchema.index({ status: 1, availableAt: 1, createdAt: 1 });
outboxEventSchema.index({ business: 1, eventType: 1, createdAt: -1 });
outboxEventSchema.index({ aggregateType: 1, aggregateId: 1, createdAt: -1 });

const OutboxEvent = mongoose.models.OutboxEvent || mongoose.model('OutboxEvent', outboxEventSchema);

export default OutboxEvent;
