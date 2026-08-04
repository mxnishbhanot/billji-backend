import mongoose from 'mongoose';
import { syncable } from './plugins/syncable.js';

// The supplier side of Customer. Deliberately thinner: no shipping address, no contact
// list, no credit balance — a shop needs to know who it buys from and what it still owes.
const vendorSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 24, default: '' },
    countryCode: { type: String, trim: true, maxlength: 8, default: '+91' },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' },
    address: { type: String, trim: true, maxlength: 500, default: '' },
    gstNumber: { type: String, trim: true, uppercase: true, maxlength: 32, default: '' },
    panNumber: { type: String, trim: true, uppercase: true, maxlength: 10, default: '' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    // Denormalized payable, recomputed from bills and vendor payments on every write —
    // same pattern as Customer.outstandingDues.
    outstandingPayable: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

syncable(vendorSchema);

vendorSchema.index({ business: 1, name: 'text', phone: 'text', gstNumber: 'text' });
vendorSchema.index({ business: 1, isActive: 1, name: 1 });
vendorSchema.index({ business: 1, updatedAt: -1 });

const Vendor = mongoose.models.Vendor || mongoose.model('Vendor', vendorSchema);

export default Vendor;
