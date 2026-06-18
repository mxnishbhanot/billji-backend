import mongoose from 'mongoose';

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
    phone: { type: String, required: true, trim: true },
    countryCode: { type: String, default: '+91', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    address: { type: String, default: '', trim: true },
    billingAddress: { type: addressSnapshotSchema, default: () => ({}) },
    shippingAddress: { type: addressSnapshotSchema, default: () => ({}) },
    gstNumber: { type: String, default: '', trim: true, uppercase: true },
    taxIdentifiers: {
      gstNumber: { type: String, default: '', trim: true, uppercase: true },
      panNumber: { type: String, default: '', trim: true, uppercase: true },
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
    unit: { type: String, default: 'pcs', trim: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    purchasePrice: { type: Number, default: 0, min: 0 },
    taxRate: { type: Number, default: 0, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
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
    total: { type: Number, required: true, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
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
    cancelReason: { type: String, default: '', trim: true, maxlength: 500 }
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

salesDocumentSchema.index({ business: 1, documentType: 1, documentNumber: 1 }, { unique: true });
salesDocumentSchema.index({ business: 1, invoiceNumber: 1 }, { unique: true, partialFilterExpression: { invoiceNumber: { $gt: '' } } });
salesDocumentSchema.index({ business: 1, documentType: 1, date: -1 });
salesDocumentSchema.index({ business: 1, documentStatus: 1, paymentStatus: 1 });
salesDocumentSchema.index({ business: 1, status: 1 });
salesDocumentSchema.index({ business: 1, documentType: 1, documentStatus: 1, paymentStatus: 1, date: -1 });
salesDocumentSchema.index({ business: 1, documentType: 1, documentStatus: 1, paymentStatus: 1, dueDate: 1 });
salesDocumentSchema.index({ business: 1, invoiceNumber: 'text', documentNumber: 'text', 'customerSnapshot.name': 'text', 'customerSnapshot.phone': 'text' });

const SalesDocument = mongoose.models.SalesDocument || mongoose.model('SalesDocument', salesDocumentSchema, 'salesdocuments');

export default SalesDocument;
