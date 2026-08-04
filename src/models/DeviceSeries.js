import mongoose from 'mongoose';

/**
 * A device's invoice numbering series.
 *
 * GST permits a business to run several concurrent document series (one per branch, per
 * counter, per document type), and a device *is* a counter. Giving each device its own
 * series is what lets an invoice issued with no signal carry its final, permanent number
 * from the moment it is printed — no temporary number, no renumbering at sync, which is
 * indefensible under audit once the customer holds a copy.
 *
 * Index 1 is the business's existing series: it renders exactly as it does today
 * (`INV-2026-27-0001`) and draws from the shared NumberSequence, so a single-device
 * business sees no change at all. Index 2 and up carry a device segment and a compressed
 * financial year to stay inside the 16-character limit — see services/numberingService.
 *
 * `counters` is the last sequence this device has had accepted, keyed `type:financialYear`.
 * It exists so the server can reject a replayed or rewound number; the device holds its own
 * copy and re-seeds from here on every registration.
 */

const deviceSeriesSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    // Device-generated UUID, stable across app restarts and sent as X-Device-Id.
    deviceId: { type: String, required: true, trim: true, maxlength: 64 },
    // 1 is the unsegmented series. 2..35 render as D2..DZ (one base-36 character).
    index: { type: Number, required: true, min: 1 },
    name: { type: String, trim: true, maxlength: 80, default: '' },
    platform: { type: String, trim: true, maxlength: 20, default: '' },
    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    counters: { type: Map, of: Number, default: () => new Map() }
  },
  { timestamps: true }
);

deviceSeriesSchema.index({ business: 1, deviceId: 1 }, { unique: true });
// A retired segment is never reissued while its row exists: numbers it has already put on
// customers' invoices must stay attributable to it.
deviceSeriesSchema.index({ business: 1, index: 1 }, { unique: true });

const DeviceSeries = mongoose.model('DeviceSeries', deviceSeriesSchema);

export default DeviceSeries;
