import mongoose from 'mongoose';

// A device that has passed 2FA and been remembered, so future logins on it skip
// the code until it expires. The client holds an opaque random token; we store
// only its SHA-256 hash. A TTL index drops rows once past expiresAt.
const trustedDeviceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    deviceName: { type: String, default: '', trim: true, maxlength: 120 },
    userAgent: { type: String, default: '', trim: true, maxlength: 500 },
    ipAddress: { type: String, default: '', trim: true, maxlength: 80 },
    lastUsedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

trustedDeviceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
trustedDeviceSchema.index({ user: 1, tokenHash: 1 });

const TrustedDevice = mongoose.models.TrustedDevice || mongoose.model('TrustedDevice', trustedDeviceSchema);

export default TrustedDevice;
