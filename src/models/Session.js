import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshTokenHash: { type: String, required: true, index: true },
    refreshTokenId: { type: String, required: true, index: true },
    refreshTokenExpiresAt: { type: Date, required: true, index: true },
    userAgent: { type: String, default: '', trim: true, maxlength: 500 },
    ipAddress: { type: String, default: '', trim: true, maxlength: 80 },
    lastUsedAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null, index: true },
    revokedReason: { type: String, default: '', trim: true, maxlength: 120 }
  },
  { timestamps: true }
);

sessionSchema.index({ user: 1, revokedAt: 1, lastUsedAt: -1 });
sessionSchema.index({ business: 1, user: 1, revokedAt: 1 });

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

export default Session;
