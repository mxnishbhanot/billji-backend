import mongoose from 'mongoose';
import { PAYMENT_METHODS } from './Payment.js';

// Money going out. Deliberately flat: a vendor here is free text, not a Vendor record,
// and there are no line items — a shop owner logging rent or transport should not have to
// model a purchase order. Purchase bills with stock and payables come in 8B.
export const EXPENSE_CATEGORIES = [
  'rent',
  'salary',
  'transport',
  'utilities',
  'purchase',
  'repairs',
  'marketing',
  'professional_fees',
  'bank_charges',
  'travel',
  'office_supplies',
  'other'
];

const expenseSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    date: { type: Date, default: Date.now, index: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: 'other', index: true },
    // Amount excluding tax, plus the GST paid on it. Input-tax credit is not claimed
    // anywhere yet, so taxAmount is recorded for the books rather than netted off.
    amount: { type: Number, required: true, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR', trim: true, uppercase: true, maxlength: 3 },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: 'cash', index: true },
    vendorName: { type: String, default: '', trim: true, maxlength: 120 },
    reference: { type: String, default: '', trim: true, maxlength: 160 },
    notes: { type: String, default: '', trim: true, maxlength: 1000 },
    // Soft-deleted so the reversing ledger entries always have their subject to point at.
    voidedAt: { type: Date, default: null, index: true },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

expenseSchema.index({ business: 1, date: -1 });
expenseSchema.index({ business: 1, category: 1, date: -1 });
expenseSchema.index({ business: 1, voidedAt: 1, date: -1 });

const Expense = mongoose.models.Expense || mongoose.model('Expense', expenseSchema);

export default Expense;
