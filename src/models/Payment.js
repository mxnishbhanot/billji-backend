import mongoose from 'mongoose';

export const PAYMENT_METHODS = ['cash', 'upi', 'bank_transfer', 'card', 'cheque', 'wallet', 'other'];
export const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'refunded'];
export const PAYMENT_TYPES = ['receipt', 'refund'];

const paymentStatusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: PAYMENT_STATUSES, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, default: '', trim: true, maxlength: 500 }
  },
  { _id: false }
);

const paymentProviderSchema = new mongoose.Schema(
  {
    provider: { type: String, default: '', trim: true, maxlength: 80 },
    providerPaymentId: { type: String, default: '', trim: true, maxlength: 160 },
    providerOrderId: { type: String, default: '', trim: true, maxlength: 160 },
    providerSignature: { type: String, default: '', trim: true, maxlength: 500 },
    webhookEventId: { type: String, default: '', trim: true, maxlength: 160 }
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    salesDocument: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesDocument', default: null, index: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    type: { type: String, enum: PAYMENT_TYPES, default: 'receipt', index: true },
    method: { type: String, enum: PAYMENT_METHODS, default: 'cash', index: true },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'completed', index: true },
    amount: { type: Number, required: true, min: 0 },
    allocatedAmount: { type: Number, default: 0, min: 0 },
    unappliedAmount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true, maxlength: 3 },
    reference: { type: String, default: '', trim: true, maxlength: 160 },
    notes: { type: String, default: '', trim: true, maxlength: 1000 },
    receivedAt: { type: Date, default: Date.now, index: true },
    provider: { type: paymentProviderSchema, default: () => ({}) },
    statusHistory: { type: [paymentStatusHistorySchema], default: () => [{ status: 'completed', at: new Date() }] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { timestamps: true }
);

paymentSchema.index({ business: 1, customer: 1, receivedAt: -1 });
paymentSchema.index({ business: 1, invoice: 1, receivedAt: -1 });
paymentSchema.index({ business: 1, status: 1, receivedAt: -1 });
paymentSchema.index({ business: 1, receivedAt: -1 });
paymentSchema.index({ business: 1, 'provider.providerPaymentId': 1 }, { sparse: true });
paymentSchema.index({ business: 1, 'provider.webhookEventId': 1 }, { sparse: true });

const Payment = mongoose.models.Payment || mongoose.model('Payment', paymentSchema);

export default Payment;
