import mongoose from 'mongoose';
import { stateCodeFromGstin, stateCodeFromName } from '../constants/gstStates.js';

const businessSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    businessName: { type: String, required: true, trim: true, maxlength: 120 },
    logoUrl: { type: String, default: '' },
    gstNumber: { type: String, default: '', trim: true, uppercase: true, maxlength: 32 },
    phone: { type: String, default: '', trim: true, maxlength: 24 },
    countryCode: { type: String, default: '+91', trim: true, maxlength: 8 },
    email: { type: String, default: '', trim: true, lowercase: true, maxlength: 120 },
    website: { type: String, default: '', trim: true, maxlength: 180 },
    address: { type: String, default: '', trim: true, maxlength: 500 },
    city: { type: String, default: '', trim: true, maxlength: 80 },
    pinCode: { type: String, default: '', trim: true, maxlength: 12 },
    state: { type: String, default: '', trim: true, maxlength: 80 },
    // GST state code of the place of business — the supplier side of every
    // CGST/SGST vs IGST decision. Derived from the GSTIN when one is set (see
    // syncStateCode below), editable directly when the business is unregistered.
    stateCode: { type: String, default: '', trim: true, maxlength: 2 },
    invoicePrefix: { type: String, default: 'INV', trim: true, uppercase: true, maxlength: 12 },
    // Per-document-type number prefixes. Each type keeps its own sequence, as GST
    // requires document series to be separate and continuous.
    quotationPrefix: { type: String, default: 'QTN', trim: true, uppercase: true, maxlength: 12 },
    challanPrefix: { type: String, default: 'DC', trim: true, uppercase: true, maxlength: 12 },
    creditNotePrefix: { type: String, default: 'CN', trim: true, uppercase: true, maxlength: 12 },
    purchasePrefix: { type: String, default: 'PUR', trim: true, uppercase: true, maxlength: 12 },
    panNumber: { type: String, default: '', trim: true, uppercase: true, maxlength: 10 },
    taxSettings: {
      defaultRate: { type: Number, default: 0, min: 0, max: 100 },
      pricesIncludeTax: { type: Boolean, default: false },
      compoundTax: { type: Boolean, default: false }
    },
    invoiceTemplate: {
      accentColor: { type: String, default: '#4338CA', trim: true, maxlength: 9 },
      showLogo: { type: Boolean, default: true },
      showNotes: { type: Boolean, default: true },
      showSignature: { type: Boolean, default: false },
      signatureUrl: { type: String, default: '' },
      showPaymentRows: { type: Boolean, default: true },
      notes: { type: String, default: '', trim: true, maxlength: 1000 }
    },
    // WhatsApp payment-reminder text. Empty = use the built-in copy. Tokens:
    // {name} {invoice} {amount} {link} {business} {days}.
    reminderTemplate: { type: String, default: '', trim: true, maxlength: 1000 },
    theme: { type: String, enum: ['light', 'dark'], default: 'light' },
    // Subscription plan. maxMembers null => derive from the plan key in TeamLimitService;
    // set it to override for a specific business. Billing/plan-change wiring comes later.
    plan: {
      key: { type: String, enum: ['free', 'pro', 'business', 'enterprise'], default: 'free' },
      maxMembers: { type: Number, default: null }
    },
    status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true }
  },
  { timestamps: true }
);

// A GSTIN carries its state in the first two digits and is authoritative — a business
// cannot be registered in one state and file from another. Only fall back to the
// free-text state field when there is no usable GSTIN.
businessSchema.pre('validate', function syncStateCode(next) {
  const fromGstin = stateCodeFromGstin(this.gstNumber);
  if (fromGstin) {
    this.stateCode = fromGstin;
  } else if (!this.stateCode) {
    this.stateCode = stateCodeFromName(this.state);
  }

  next();
});

businessSchema.index({ owner: 1, businessName: 1 });

const Business = mongoose.model('Business', businessSchema);

export default Business;
