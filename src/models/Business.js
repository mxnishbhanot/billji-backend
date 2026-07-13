import mongoose from 'mongoose';

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
    invoicePrefix: { type: String, default: 'INV', trim: true, uppercase: true, maxlength: 12 },
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

businessSchema.index({ owner: 1, businessName: 1 });

const Business = mongoose.model('Business', businessSchema);

export default Business;
