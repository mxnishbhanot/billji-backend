import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

// A single unused/used recovery code. Only the SHA-256 hash is stored, never the
// plaintext — codes are shown to the user exactly once at generation time.
const backupCodeSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true },
    usedAt: { type: Date, default: null }
  },
  { _id: false }
);

// Two-factor config. `method` is the single active factor ('none' until enrolled).
// Secrets are select:false so they never leak into a normal query / API response;
// the controller opts them in explicitly when it needs to verify a code.
const twoFactorSchema = new mongoose.Schema(
  {
    method: { type: String, enum: ['none', 'totp', 'email'], default: 'none' },
    // AES-256-GCM encrypted base32 TOTP secret (only set once TOTP is enabled).
    totpSecret: { type: String, default: null, select: false },
    // Method + secret staged during enrollment, promoted on successful verify.
    pendingMethod: { type: String, enum: ['totp', 'email', null], default: null },
    pendingTotpSecret: { type: String, default: null, select: false },
    backupCodes: { type: [backupCodeSchema], default: [], select: false },
    enabledAt: { type: Date, default: null }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    password: { type: String, required: true, minlength: 8, select: false },
    defaultBusiness: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', default: null, index: true },
    // BillJi-staff access, a different axis from the per-business RBAC in BusinessMember/Role:
    // this grants nothing inside any business, only on the platform admin API (plans, coupons,
    // refunds). Deliberately a coarse field rather than a second permission system — promote a
    // user with a one-off script, never through an API. Schema only in this phase; the
    // requirePlatformAdmin guard and admin routes land in P6.
    platformRole: { type: String, enum: ['none', 'support', 'admin'], default: 'none', index: true },
    /**
     * This user's own referral code — short, human-readable, permanent, and never editable: no route
     * writes it, and referralService only ever fills it in when it is absent.
     *
     * No default, and a PARTIAL unique index (below) rather than a sparse one: sparse only skips a
     * missing field, so `default: null` would put an explicit null on every new user and the second
     * signup would collide with the first. Same reasoning as the syncable plugin's clientId index.
     */
    referralCode: { type: String, trim: true, uppercase: true, maxlength: 12 },
    /**
     * Who referred this user. Set once, in the same call that creates the Referral, and never cleared
     * — not even when a referral is voided, because "has already used a code" must stay true for ever.
     *
     * Referral.referredUser (unique) remains the authority; this is the denormalized copy that lets an
     * eligibility check answer the common case off the user document `protect` already loaded.
     */
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    twoFactor: { type: twoFactorSchema, default: () => ({}) }
  },
  { timestamps: true }
);

// Unique only among users who actually have a code. Users created before the feature carry no field
// at all until their first referral-screen read (or the backfill script) mints one.
userSchema.index({ referralCode: 1 }, { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) {
    return next();
  }

  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

const User = mongoose.model('User', userSchema);

export default User;
