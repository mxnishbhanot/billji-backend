import bcrypt from 'bcrypt';
import mongoose from 'mongoose';

const businessProfileSchema = new mongoose.Schema(
  {
    businessName: { type: String, default: 'QuickInvoice Business', trim: true, maxlength: 120 },
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
    theme: { type: String, enum: ['light', 'dark'], default: 'light' }
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    password: { type: String, required: true, minlength: 8, select: false },
    businessProfile: { type: businessProfileSchema, default: () => ({}) }
  },
  { timestamps: true }
);

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
