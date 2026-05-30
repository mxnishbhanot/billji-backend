import mongoose from 'mongoose';

export const LEDGER_ACCOUNTS = ['cash', 'bank', 'accounts_receivable', 'customer_credits', 'sales', 'refunds', 'adjustments'];
export const LEDGER_DIRECTIONS = ['debit', 'credit'];
export const LEDGER_SOURCE_TYPES = ['invoice', 'payment', 'refund', 'adjustment'];

const ledgerEntrySchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    salesDocument: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesDocument', default: null, index: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null, index: true },
    sourceType: { type: String, enum: LEDGER_SOURCE_TYPES, required: true, index: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    account: { type: String, enum: LEDGER_ACCOUNTS, required: true, index: true },
    direction: { type: String, enum: LEDGER_DIRECTIONS, required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true, maxlength: 3 },
    entryDate: { type: Date, default: Date.now, index: true },
    description: { type: String, default: '', trim: true, maxlength: 500 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) }
  },
  { timestamps: true }
);

ledgerEntrySchema.index({ business: 1, account: 1, entryDate: -1 });
ledgerEntrySchema.index({ business: 1, sourceType: 1, sourceId: 1 });
ledgerEntrySchema.index({ business: 1, customer: 1, entryDate: -1 });

const LedgerEntry = mongoose.models.LedgerEntry || mongoose.model('LedgerEntry', ledgerEntrySchema);

export default LedgerEntry;
