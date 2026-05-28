import mongoose from 'mongoose';

const paymentAllocationSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true, index: true },
    salesDocument: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesDocument', required: true, index: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    amount: { type: Number, required: true, min: 0 },
    allocatedAt: { type: Date, default: Date.now, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true }
  },
  { timestamps: true }
);

paymentAllocationSchema.index({ business: 1, invoice: 1, allocatedAt: -1 });
paymentAllocationSchema.index({ business: 1, customer: 1, allocatedAt: -1 });

const PaymentAllocation = mongoose.models.PaymentAllocation || mongoose.model('PaymentAllocation', paymentAllocationSchema);

export default PaymentAllocation;
