import mongoose from 'mongoose';
import { liveUniqueIndex, syncable } from './plugins/syncable.js';

export const PURCHASE_STATUSES = ['received', 'cancelled'];
export const PURCHASE_PAYMENT_STATUSES = ['unpaid', 'partial', 'paid'];

// Mirrors salesDocumentItemSchema, minus anything buyer-facing. purchasePrice is the
// price we paid — it flows onto Product.purchasePrice so margin stays current.
const purchaseItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true },
    hsn: { type: String, default: '', trim: true, maxlength: 8 },
    unit: { type: String, default: 'pcs', trim: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0, min: 0 },
    taxableValue: { type: Number, default: 0, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    cgst: { type: Number, default: 0, min: 0 },
    sgst: { type: Number, default: 0, min: 0 },
    igst: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    // A bill line can be for something that isn't a tracked product (freight, packing).
    isCustom: { type: Boolean, default: false }
  },
  { _id: true }
);

const purchaseBillSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    // Snapshot so a renamed or deleted vendor never rewrites history, exactly as invoices
    // snapshot the customer.
    vendorSnapshot: {
      name: { type: String, required: true, trim: true },
      phone: { type: String, default: '', trim: true },
      gstNumber: { type: String, default: '', trim: true, uppercase: true }
    },
    // Our own sequential number (PUR-FY-0001).
    billNumber: { type: String, required: true, trim: true },
    // What the supplier called it on their invoice — what you match against their books.
    vendorBillNumber: { type: String, default: '', trim: true, maxlength: 64 },
    date: { type: Date, default: Date.now, index: true },
    dueDate: { type: Date, default: null },
    items: { type: [purchaseItemSchema], validate: (items) => items.length > 0 },
    subtotal: { type: Number, required: true, min: 0 },
    taxTotal: { type: Number, default: 0, min: 0 },
    cgstTotal: { type: Number, default: 0, min: 0 },
    sgstTotal: { type: Number, default: 0, min: 0 },
    igstTotal: { type: Number, default: 0, min: 0 },
    discount: {
      type: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
      value: { type: Number, default: 0, min: 0 },
      amount: { type: Number, default: 0, min: 0 }
    },
    total: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    balanceDue: { type: Number, default: 0, min: 0 },
    supplyType: { type: String, enum: ['intra', 'inter'], default: 'intra' },
    placeOfSupply: {
      code: { type: String, default: '', trim: true, maxlength: 2 },
      state: { type: String, default: '', trim: true, maxlength: 80 }
    },
    status: { type: String, enum: PURCHASE_STATUSES, default: 'received', index: true },
    paymentStatus: { type: String, enum: PURCHASE_PAYMENT_STATUSES, default: 'unpaid', index: true },
    notes: { type: String, default: '', trim: true, maxlength: 1000 },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '', trim: true, maxlength: 500 }
  },
  { timestamps: true }
);

syncable(purchaseBillSchema);

purchaseBillSchema.index({ business: 1, billNumber: 1 }, liveUniqueIndex());
purchaseBillSchema.index({ business: 1, date: -1 });
purchaseBillSchema.index({ business: 1, vendor: 1, date: -1 });
purchaseBillSchema.index({ business: 1, status: 1, paymentStatus: 1, date: -1 });

const PurchaseBill = mongoose.models.PurchaseBill || mongoose.model('PurchaseBill', purchaseBillSchema);

export default PurchaseBill;
