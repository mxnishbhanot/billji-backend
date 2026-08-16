import mongoose from 'mongoose';
import { liveUniqueIndex, syncable } from './plugins/syncable.js';

export const SALES_DOCUMENT_TYPES = ['quotation', 'order', 'invoice', 'delivery_challan', 'credit_note', 'refund_note'];
export const DOCUMENT_STATUSES = ['draft', 'issued', 'cancelled', 'void'];
export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'refunded'];
export const FULFILLMENT_STATUSES = ['pending', 'delivered', 'returned', 'not_applicable'];
export const LEGACY_INVOICE_STATUSES = ['pending', 'paid', 'cancelled'];

const addressSnapshotSchema = new mongoose.Schema(
  {
    line1: { type: String, default: '', trim: true },
    line2: { type: String, default: '', trim: true },
    city: { type: String, default: '', trim: true },
    state: { type: String, default: '', trim: true },
    pinCode: { type: String, default: '', trim: true },
    country: { type: String, default: 'India', trim: true }
  },
  { _id: false }
);

const customerSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Blank on a genuine counter/walk-in sale: the document has no customer at all
    // (customer: null) and there is nobody to record a number for.
    phone: { type: String, default: '', trim: true },
    countryCode: { type: String, default: '+91', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    address: { type: String, default: '', trim: true },
    billingAddress: { type: addressSnapshotSchema, default: () => ({}) },
    shippingAddress: { type: addressSnapshotSchema, default: () => ({}) },
    gstNumber: { type: String, default: '', trim: true, uppercase: true },
    taxIdentifiers: {
      gstNumber: { type: String, default: '', trim: true, uppercase: true },
      panNumber: { type: String, default: '', trim: true, uppercase: true, maxlength: 10 },
      taxId: { type: String, default: '', trim: true }
    }
  },
  { _id: false }
);

const salesDocumentItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true },
    // HSN (goods) / SAC (services) classification code — mandatory on B2B GST invoices.
    hsn: { type: String, default: '', trim: true, maxlength: 8 },
    unit: { type: String, default: 'pcs', trim: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    purchasePrice: { type: Number, default: 0, min: 0 },
    taxRate: { type: Number, default: 0, min: 0 },
    // Line value the tax was charged on: gross minus this line's share of any
    // document-level discount (and net of tax when prices are tax-inclusive).
    taxableValue: { type: Number, default: 0, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    // Exactly one of (cgst+sgst) or igst is non-zero, decided by place of supply.
    cgst: { type: Number, default: 0, min: 0 },
    sgst: { type: Number, default: 0, min: 0 },
    igst: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
    isCustom: { type: Boolean, default: false }
  },
  { _id: true }
);

export const legacyStatusFor = ({ documentStatus, paymentStatus } = {}) => {
  if (documentStatus === 'cancelled' || documentStatus === 'void') return 'cancelled';
  if (paymentStatus === 'paid' || paymentStatus === 'refunded') return 'paid';
  return 'pending';
};

export const domainStatusesForLegacy = (status = 'pending') => {
  if (status === 'paid') {
    return { documentStatus: 'issued', paymentStatus: 'paid' };
  }

  if (status === 'cancelled') {
    return { documentStatus: 'cancelled', paymentStatus: 'unpaid' };
  }

  return { documentStatus: 'issued', paymentStatus: 'unpaid' };
};

export const salesDocumentSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    // OR-0: nullable link to source Order. Null = direct invoice (legacy flow). Ref is 1->N; service enforces 1->1.
    sourceOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    // The invoice a credit note reverses, or the quotation/challan an invoice came from.
    // Service enforces the 1->1 rules; the ref itself is deliberately permissive.
    sourceInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
    sourceDocument: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
    // Quotation only: the date the offer lapses.
    validUntil: { type: Date, default: null },
    // Credit note only: why the goods came back.
    reason: { type: String, default: '', trim: true, maxlength: 500 },
    documentType: { type: String, enum: SALES_DOCUMENT_TYPES, default: 'invoice', required: true, index: true },
    documentNumber: { type: String, required: true, trim: true },
    invoiceNumber: { type: String, trim: true },
    date: { type: Date, default: Date.now, index: true },
    dueDate: { type: Date, default: null },
    customerSnapshot: { type: customerSnapshotSchema, required: true },
    items: { type: [salesDocumentItemSchema], validate: (items) => items.length > 0 },
    subtotal: { type: Number, required: true, min: 0 },
    tax: {
      rate: { type: Number, default: 0, min: 0 },
      amount: { type: Number, default: 0, min: 0 }
    },
    discount: {
      type: { type: String, enum: ['flat', 'percentage'], default: 'flat' },
      value: { type: Number, default: 0, min: 0 },
      amount: { type: Number, default: 0, min: 0 }
    },
    // GST place of supply. Absent on documents issued before the GST engine landed —
    // renderers and returns treat a missing taxSummary as "legacy, single-rate".
    placeOfSupply: {
      code: { type: String, default: '', trim: true, maxlength: 2 },
      state: { type: String, default: '', trim: true, maxlength: 80 }
    },
    supplyType: { type: String, enum: ['intra', 'inter'], default: 'intra' },
    // HSN-wise rollup, the shape both the printed invoice and GSTR-1 need.
    taxSummary: {
      type: [
        {
          _id: false,
          hsn: { type: String, default: '', trim: true, maxlength: 8 },
          rate: { type: Number, default: 0, min: 0 },
          taxableValue: { type: Number, default: 0, min: 0 },
          cgst: { type: Number, default: 0, min: 0 },
          sgst: { type: Number, default: 0, min: 0 },
          igst: { type: Number, default: 0, min: 0 },
          taxAmount: { type: Number, default: 0, min: 0 }
        }
      ],
      default: []
    },
    total: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    // Credit-note counters. On a credit note: `appliedAmount` is how much of it has been
    // consumed. On an invoice: `creditedAmount` is the credit-note value raised against it,
    // `creditApplied` is the credit used to settle it. Nothing reads them yet.
    appliedAmount: { type: Number, default: 0, min: 0 },
    creditedAmount: { type: Number, default: 0, min: 0 },
    creditApplied: { type: Number, default: 0, min: 0 },
    balanceDue: { type: Number, default: 0, min: 0 },
    documentStatus: { type: String, enum: DOCUMENT_STATUSES, default: 'issued', index: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid', index: true },
    fulfillmentStatus: { type: String, enum: FULFILLMENT_STATUSES, default: 'pending', index: true },
    status: { type: String, enum: LEGACY_INVOICE_STATUSES, default: 'pending', index: true },
    notes: { type: String, default: '', trim: true, maxlength: 1000 },
    pdfUrl: { type: String, default: '' },
    pdfCacheKey: { type: String, default: '' },
    shareToken: { type: String, required: true, unique: true },
    shareExpiresAt: { type: Date, default: null, index: true },
    shareRevokedAt: { type: Date, default: null, index: true },
    emailedAt: { type: Date, default: null },
    // Audit trail for cancellation (cancel preserves the document; never physically deleted).
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancelReason: { type: String, default: '', trim: true, maxlength: 500 },
    // Set when a cancelled invoice's refund-pending receipts are marked refunded
    // manually — lets the list card drop the "Refund pending" flag without a
    // per-invoice payment lookup. Flag-only; no money moves.
    refundResolvedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

salesDocumentSchema.pre('validate', function syncCompatibilityFields(next) {
  if (!this.documentNumber && this.invoiceNumber) {
    this.documentNumber = this.invoiceNumber;
  }

  if (!this.invoiceNumber && this.documentType === 'invoice' && this.documentNumber) {
    this.invoiceNumber = this.documentNumber;
  }

  if (this.isModified('status')) {
    const domainStatuses = domainStatusesForLegacy(this.status);
    this.documentStatus = domainStatuses.documentStatus;
    this.paymentStatus = domainStatuses.paymentStatus;
  } else {
    this.status = legacyStatusFor({
      documentStatus: this.documentStatus,
      paymentStatus: this.paymentStatus
    });
  }

  next();
});

// Invoice and SalesDocument are two models over this one schema object, so the plugin is
// applied here exactly once and both inherit it.
syncable(salesDocumentSchema);

// Tombstoned documents release their number back to the series. The sequence never hands
// the same number out twice regardless, so this only prevents a phantom collision.
salesDocumentSchema.index({ business: 1, documentType: 1, documentNumber: 1 }, liveUniqueIndex());
salesDocumentSchema.index({ business: 1, invoiceNumber: 1 }, liveUniqueIndex({ invoiceNumber: { $gt: '' } }));
salesDocumentSchema.index({ business: 1, documentType: 1, date: -1 });
salesDocumentSchema.index({ business: 1, documentStatus: 1, paymentStatus: 1 });
salesDocumentSchema.index({ business: 1, status: 1 });
salesDocumentSchema.index({ business: 1, documentType: 1, documentStatus: 1, paymentStatus: 1, date: -1 });
salesDocumentSchema.index({ business: 1, documentType: 1, documentStatus: 1, paymentStatus: 1, dueDate: 1 });
salesDocumentSchema.index({ business: 1, invoiceNumber: 'text', documentNumber: 'text', 'customerSnapshot.name': 'text', 'customerSnapshot.phone': 'text' });

const SalesDocument = mongoose.models.SalesDocument || mongoose.model('SalesDocument', salesDocumentSchema, 'salesdocuments');

export default SalesDocument;
