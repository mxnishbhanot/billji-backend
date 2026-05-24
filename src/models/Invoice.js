import mongoose from 'mongoose';

const customerSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    address: { type: String, default: '', trim: true }
  },
  { _id: false }
);

const invoiceItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    isCustom: { type: Boolean, default: false }
  },
  { _id: true }
);

const invoiceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    invoiceNumber: { type: String, required: true },
    date: { type: Date, default: Date.now },
    dueDate: { type: Date, default: null },
    customerSnapshot: { type: customerSnapshotSchema, required: true },
    items: { type: [invoiceItemSchema], validate: (items) => items.length > 0 },
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
    status: { type: String, enum: ['pending', 'paid', 'cancelled'], default: 'pending', index: true },
    notes: { type: String, default: '', trim: true, maxlength: 1000 },
    pdfUrl: { type: String, default: '' },
    shareToken: { type: String, required: true, unique: true },
    emailedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

invoiceSchema.index({ user: 1, invoiceNumber: 1 }, { unique: true });
invoiceSchema.index({ user: 1, date: -1 });
invoiceSchema.index({ user: 1, status: 1 });
invoiceSchema.index({ user: 1, invoiceNumber: 'text', 'customerSnapshot.name': 'text', 'customerSnapshot.phone': 'text' });

const Invoice = mongoose.model('Invoice', invoiceSchema);

export default Invoice;
