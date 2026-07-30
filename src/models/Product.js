import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    price: { type: Number, required: true, min: 0 },
    salePrice: { type: Number, min: 0 },
    purchasePrice: { type: Number, default: 0, min: 0 },
    stockQuantity: { type: Number, required: true, default: 0, min: 0 },
    sku: { type: String, trim: true, maxlength: 64, default: '' },
    // HSN (goods) / SAC (services) code, copied onto invoice lines at billing time.
    hsn: { type: String, trim: true, maxlength: 8, default: '' },
    // Scanned product code (EAN-13, UPC, QR, or whatever the shop's label carries).
    // Unique per business so a scan resolves to exactly one product.
    barcode: { type: String, trim: true, maxlength: 64, default: '' },
    category: { type: String, trim: true, maxlength: 80, default: '' },
    unit: { type: String, trim: true, maxlength: 24, default: 'pcs' },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    trackStock: { type: Boolean, default: true },
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

productSchema.pre('validate', function syncProductCompatibility(next) {
  if (this.salePrice === undefined || this.salePrice === null) {
    this.salePrice = this.price;
  }

  if (this.price === undefined || this.price === null) {
    this.price = this.salePrice;
  }

  next();
});

productSchema.index({ business: 1, name: 'text', sku: 'text', category: 'text' });
productSchema.index({ business: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $gt: '' } } });
// Same shape as the sku index: unique only among products that actually have a barcode,
// so the many products without one do not collide on empty string.
productSchema.index({ business: 1, barcode: 1 }, { unique: true, partialFilterExpression: { barcode: { $gt: '' } } });
productSchema.index({ business: 1, isActive: 1, trackStock: 1 });
productSchema.index({ business: 1, trackStock: 1, stockQuantity: 1, updatedAt: -1 });

productSchema.virtual('isLowStock').get(function isLowStock() {
  return this.stockQuantity <= this.lowStockThreshold;
});

const Product = mongoose.model('Product', productSchema);

export default Product;
