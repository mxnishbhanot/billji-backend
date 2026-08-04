import mongoose from 'mongoose';
import { syncable } from './plugins/syncable.js';

// The referrer -> referred edge. One row per referred user, for ever.
//
// Deliberately NOT a counter on User: the edge carries state (pending -> converted), the payment
// that converted it, and the signup fingerprint used for abuse checks. A counter could express
// none of that, and "how many did Priya refer?" is a countDocuments on an indexed field.
//
// This is the collection the offline push writes (`referral:create`), so it carries the syncable
// plugin's clientId — that is what makes a retried push echo-match the row it already created
// instead of attempting a second one. Soft delete is off: a referral is never deleted, only voided,
// because deleting it would make the referred user eligible again.

export const REFERRAL_STATUSES = ['pending', 'converted', 'void'];

const referralSchema = new mongoose.Schema(
  {
    referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // UNIQUE, and the load-bearing guarantee of the whole feature: no user can ever be referred
    // twice, whatever an eligibility check, a race, or a replayed sync op tries.
    referredUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    // The referred user's business at apply time. Required by the sync push path, which scopes
    // every echo-match to req.business, and it records which workspace received the signup reward.
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    // Denormalized: survives the referrer renaming, and answers "which code" if codes ever rotate.
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 12 },
    // Future campaigns with no migration. Nothing branches on it yet.
    campaign: { type: String, default: 'default', trim: true, lowercase: true, maxlength: 40, index: true },

    status: { type: String, enum: REFERRAL_STATUSES, default: 'pending', index: true },

    // Abuse forensics. Nothing else in the system records who signed up from where.
    signup: {
      ip: { type: String, default: '', trim: true, maxlength: 60 },
      deviceName: { type: String, default: '', trim: true, maxlength: 120 },
      userAgent: { type: String, default: '', trim: true, maxlength: 300 }
    },

    // The first paid purchase that converted this referral, and when. The payment id is what a
    // refund reverses the referrer's reward from.
    convertedAt: { type: Date, default: null },
    qualifyingPayment: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPayment', default: null },
    voidReason: { type: String, default: '', trim: true, maxlength: 300 }
  },
  { timestamps: true }
);

// Never pulled by a device, so no cursor index is needed for its own sake — the plugin's
// (business, clientId) partial unique index is what this is here for.
syncable(referralSchema, { softDelete: false });

// "Priya's referrals, newest first" and the pending -> converted scan.
referralSchema.index({ referrer: 1, status: 1, createdAt: -1 });
// A refund finds the referral it must reverse.
referralSchema.index({ qualifyingPayment: 1 }, { sparse: true });

const Referral = mongoose.model('Referral', referralSchema);

export default Referral;
