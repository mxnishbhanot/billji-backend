import mongoose from 'mongoose';
import { liveUniqueIndex, syncable } from './plugins/syncable.js';

const addressSchema = new mongoose.Schema(
  {
    line1: { type: String, trim: true, maxlength: 200, default: '' },
    line2: { type: String, trim: true, maxlength: 200, default: '' },
    city: { type: String, trim: true, maxlength: 80, default: '' },
    state: { type: String, trim: true, maxlength: 80, default: '' },
    pinCode: { type: String, trim: true, maxlength: 16, default: '' },
    country: { type: String, trim: true, maxlength: 80, default: 'India' }
  },
  { _id: false }
);

const contactPersonSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 120, default: '' },
    role: { type: String, trim: true, maxlength: 80, default: '' },
    phone: { type: String, trim: true, maxlength: 24, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' }
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 24 },
    countryCode: { type: String, trim: true, maxlength: 8, default: '+91' },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' },
    address: { type: String, trim: true, maxlength: 500, default: '' },
    billingAddress: { type: addressSchema, default: () => ({}) },
    shippingAddress: { type: addressSchema, default: () => ({}) },
    gstNumber: { type: String, trim: true, uppercase: true, maxlength: 32, default: '' },
    taxIdentifiers: {
      gstNumber: { type: String, trim: true, uppercase: true, maxlength: 32, default: '' },
      panNumber: { type: String, trim: true, uppercase: true, maxlength: 10, default: '' },
      taxId: { type: String, trim: true, maxlength: 64, default: '' }
    },
    contactPersons: { type: [contactPersonSchema], default: [] },
    creditBalance: { type: Number, default: 0, min: 0 },
    outstandingDues: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

customerSchema.pre('validate', function syncCustomerCompatibility(next) {
  if (!this.billingAddress?.line1 && this.address) {
    this.billingAddress = { ...(this.billingAddress?.toObject?.() || this.billingAddress || {}), line1: this.address };
  }

  if (!this.shippingAddress?.line1 && this.address) {
    this.shippingAddress = { ...(this.shippingAddress?.toObject?.() || this.shippingAddress || {}), line1: this.address };
  }

  if (!this.gstNumber && this.taxIdentifiers?.gstNumber) {
    this.gstNumber = this.taxIdentifiers.gstNumber;
  }

  if (this.gstNumber && !this.taxIdentifiers?.gstNumber) {
    this.taxIdentifiers = { ...(this.taxIdentifiers?.toObject?.() || this.taxIdentifiers || {}), gstNumber: this.gstNumber };
  }

  next();
});

syncable(customerSchema);

customerSchema.index({ business: 1, name: 'text', phone: 'text', email: 'text', gstNumber: 'text' });
customerSchema.index({ business: 1, isActive: 1 });
customerSchema.index({ business: 1, updatedAt: -1 });
customerSchema.index({ business: 1, createdAt: -1 });
customerSchema.index({ business: 1, name: 1 });
// Soft-deleted rows release the phone so a re-created walk-in can reuse it.
customerSchema.index({ business: 1, phone: 1 }, liveUniqueIndex({ phone: { $gt: '' } }));

const Customer = mongoose.model('Customer', customerSchema);

export default Customer;
