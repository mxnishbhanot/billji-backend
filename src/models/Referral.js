import mongoose from 'mongoose';
import { syncable } from './plugins/syncable.js';

export const REFERRAL_STATUSES = ['pending', 'converted', 'void'];

/**
 * One row per REFERRED business: "this business joined on that business's code".
 *
 * Keyed on the referred side, uniquely, because that is the rule the whole feature rests on — a
 * business can be referred once, ever. The referrer side is a plain index: being referred by the
 * same code many times is the point.
 *
 * `pending` means the free month has been granted and the referrer's reward has not: it is waiting
 * on the referred business to actually pay. `converted` is set by the payment path, once.
 */
const referralSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
    referrerBusiness: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    // The code as typed and normalised, kept even if the referrer later regenerates theirs.
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
    status: { type: String, enum: REFERRAL_STATUSES, default: 'pending', index: true },
    appliedAt: { type: Date, default: () => new Date() },
    convertedAt: { type: Date, default: null },
    // Why a pending referral was voided (self-serve refund, fraud review). Display/support only.
    voidReason: { type: String, default: '', trim: true, maxlength: 300 }
  },
  { timestamps: true }
);

// Carries clientId + version so an APPLY_REFERRAL pushed from the outbox dedupes on retry the same
// way every other offline create does. No tombstone: a referral is never deleted.
referralSchema.plugin(syncable, { softDelete: false });

const Referral = mongoose.model('Referral', referralSchema);

export default Referral;
