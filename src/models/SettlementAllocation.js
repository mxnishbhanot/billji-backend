import mongoose from 'mongoose';

/**
 * One row = "this invoice was settled by this amount, from this source".
 *
 * Cash and customer credit are two funding sources for one operation, so both live here
 * rather than in parallel collections — the same choice `Payment` makes for
 * receipt/refund/vendor_payment. An invoice therefore keeps exactly one settlement
 * channel: `balanceDue = total - Σ non-reversed allocations`.
 *
 * Reversal is a soft flag (`reversedAt`), never a delete, matching the codebase's
 * compensate-never-delete convention. Every aggregate over this collection must filter
 * `reversedAt: null`.
 */
const settlementAllocationSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    source: { type: String, enum: ['payment', 'credit_note'], required: true, index: true },
    // Exactly one of these is set, decided by `source` — enforced below.
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null, index: true },
    creditNote: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesDocument', default: null, index: true },
    salesDocument: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesDocument', required: true, index: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    amount: { type: Number, required: true, min: 0 },
    allocatedAt: { type: Date, default: Date.now, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    reversedAt: { type: Date, default: null, index: true },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reversalReason: { type: String, default: '', trim: true, maxlength: 200 }
  },
  { timestamps: true }
);

// Schema-level XOR: a row naming both sources, or neither, is not a settlement fact.
// Enforced here rather than in the service so no caller can write a malformed row.
settlementAllocationSchema.pre('validate', function enforceSourceXor(next) {
  if (this.source === 'payment') {
    if (!this.payment) return next(new Error('SettlementAllocation: payment is required when source is "payment"'));
    if (this.creditNote) return next(new Error('SettlementAllocation: creditNote must be null when source is "payment"'));
    return next();
  }
  if (this.source === 'credit_note') {
    if (!this.creditNote) return next(new Error('SettlementAllocation: creditNote is required when source is "credit_note"'));
    if (this.payment) return next(new Error('SettlementAllocation: payment must be null when source is "credit_note"'));
    return next();
  }
  return next();
});

settlementAllocationSchema.index({ business: 1, invoice: 1, allocatedAt: -1 });
settlementAllocationSchema.index({ business: 1, customer: 1, allocatedAt: -1 });
settlementAllocationSchema.index({ business: 1, creditNote: 1, allocatedAt: -1 });
settlementAllocationSchema.index({ business: 1, source: 1, allocatedAt: -1 });

const SettlementAllocation =
  mongoose.models.SettlementAllocation || mongoose.model('SettlementAllocation', settlementAllocationSchema, 'settlementallocations');

export default SettlementAllocation;
