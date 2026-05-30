import mongoose from 'mongoose';

const idempotencyKeySchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    key: { type: String, required: true, trim: true, maxlength: 180 },
    method: { type: String, required: true, trim: true, uppercase: true, maxlength: 12 },
    path: { type: String, required: true, trim: true, maxlength: 240 },
    requestHash: { type: String, required: true, trim: true, maxlength: 128 },
    status: { type: String, enum: ['processing', 'completed', 'failed'], default: 'processing', index: true },
    responseStatus: { type: Number, default: null },
    responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
    lockedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  { timestamps: true }
);

idempotencyKeySchema.index({ business: 1, key: 1 }, { unique: true });

const IdempotencyKey = mongoose.model('IdempotencyKey', idempotencyKeySchema);

export default IdempotencyKey;
