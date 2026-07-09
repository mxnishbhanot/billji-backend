import mongoose from 'mongoose';

// One-time email code used for a 2FA step. Mirrors PasswordResetToken: only the
// SHA-256 hash is stored, a TTL index expires stale rows, and `attempts` caps
// brute-force guessing. `purpose` distinguishes an enrollment code from a login
// code so a code minted for one flow can't be replayed in the other.
const twoFactorChallengeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    codeHash: { type: String, required: true, unique: true },
    // login: completing a sign-in. enroll: turning email 2FA on. manage: a
    // sensitive op on an already-active email 2FA account (disable / regen codes).
    purpose: { type: String, enum: ['login', 'enroll', 'manage'], required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    requestedIp: { type: String, default: '', trim: true, maxlength: 80 }
  },
  { timestamps: true }
);

twoFactorChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
twoFactorChallengeSchema.index({ user: 1, purpose: 1, usedAt: 1 });

const TwoFactorChallenge =
  mongoose.models.TwoFactorChallenge || mongoose.model('TwoFactorChallenge', twoFactorChallengeSchema);

export default TwoFactorChallenge;
