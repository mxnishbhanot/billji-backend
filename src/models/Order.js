import mongoose from 'mongoose';

export const ORDER_STATUSES = ['draft', 'confirmed', 'fulfilled', 'cancelled'];
export const ORDER_FULFILLMENT_STATUSES = ['pending', 'delivered', 'returned', 'not_applicable'];
export const ORDER_PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'refunded'];

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
      panNumber: { type: String, default: '', trim: true, uppercase: true, maxlength: 10 },
      taxId: { type: String, default: '', trim: true }
    }
  },
  { _id: false }
);

const orderItemSchema = new mongoose.Schema(
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

const orderSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null, index: true },
    customerSnapshot: { type: customerSnapshotSchema, required: true },
    orderNumber: { type: String, required: true, trim: true },
    date: { type: Date, default: Date.now, index: true },
    items: { type: [orderItemSchema], validate: (items) => items.length > 0 },
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
    orderStatus: { type: String, enum: ORDER_STATUSES, default: 'draft', index: true },
    fulfillmentStatus: { type: String, enum: ORDER_FULFILLMENT_STATUSES, default: 'pending', index: true },
    // Derived cache — never authoritative. Recomputed from linked invoice(s) in OR-3.
    paymentStatus: { type: String, enum: ORDER_PAYMENT_STATUSES, default: 'unpaid', index: true },
    paidAmount: { type: Number, default: 0, min: 0 },
    balanceDue: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: '', trim: true, maxlength: 1000 }
  },
  { timestamps: true }
);

orderSchema.index({ business: 1, orderStatus: 1, createdAt: -1 });
orderSchema.index({ business: 1, paymentStatus: 1, date: -1 });
orderSchema.index({ business: 1, fulfillmentStatus: 1, date: -1 });
orderSchema.index({ business: 1, date: -1 });
orderSchema.index({ business: 1, customer: 1, createdAt: -1 });
orderSchema.index({ business: 1, orderNumber: 1 }, { unique: true });

const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

export default Order;
