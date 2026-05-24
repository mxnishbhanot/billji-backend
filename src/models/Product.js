import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    price: { type: Number, required: true, min: 0 },
    stockQuantity: { type: Number, required: true, default: 0 },
    sku: { type: String, trim: true, maxlength: 64, default: '' },
    category: { type: String, trim: true, maxlength: 80, default: '' },
    lowStockThreshold: { type: Number, default: 5, min: 0 }
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

productSchema.index({ user: 1, name: 'text', sku: 'text', category: 'text' });
productSchema.index({ user: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $gt: '' } } });

productSchema.virtual('isLowStock').get(function isLowStock() {
  return this.stockQuantity <= this.lowStockThreshold;
});

const Product = mongoose.model('Product', productSchema);

export default Product;
