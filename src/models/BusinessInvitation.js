import mongoose from 'mongoose';

// Team invitation. Mirrors PasswordResetToken (raw token emailed, only the SHA-256
// tokenHash stored, TTL-expiring, single-use, attempts-capped). Stores a role snapshot
// (roleKey + roleName) alongside the role ref so a custom role deleted/archived before
// acceptance cannot break the accept flow.
const businessInvitationSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    roleKey: {
      type: String,
      enum: ['owner', 'admin', 'accountant', 'staff', 'viewer'],
      required: true
    },
    role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null },
    roleName: { type: String, default: '', trim: true, maxlength: 80 },
    tokenHash: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'cancelled', 'expired'],
      default: 'pending',
      index: true
    },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 }
  },
  { timestamps: true }
);

businessInvitationSchema.index({ business: 1, status: 1 });
businessInvitationSchema.index({ email: 1, status: 1 });
// Auto-purge accepted/expired rows a while after they expire (does not fire on pending
// rows before expiry). Accept/list logic still checks expiresAt explicitly.
businessInvitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

const BusinessInvitation =
  mongoose.models.BusinessInvitation || mongoose.model('BusinessInvitation', businessInvitationSchema);

export default BusinessInvitation;
