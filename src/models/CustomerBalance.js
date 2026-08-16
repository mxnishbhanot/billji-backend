import mongoose from 'mongoose';

const customerBalanceSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    outstandingDues: { type: Number, default: 0, min: 0 },
    availableCredit: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true, maxlength: 3 },
    lastCalculatedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

customerBalanceSchema.index({ business: 1, customer: 1 }, { unique: true });

const CustomerBalance = mongoose.models.CustomerBalance || mongoose.model('CustomerBalance', customerBalanceSchema);

export default CustomerBalance;
