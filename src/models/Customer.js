import mongoose from 'mongoose';

const customerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 24 },
    countryCode: { type: String, default: '+91', trim: true, maxlength: 6 },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: '' },
    address: { type: String, trim: true, maxlength: 500, default: '' }
  },
  { timestamps: true }
);

customerSchema.index({ user: 1, name: 'text', phone: 'text', email: 'text' });

const Customer = mongoose.model('Customer', customerSchema);

export default Customer;
