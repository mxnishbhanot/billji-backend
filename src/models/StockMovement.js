import mongoose from 'mongoose';

const stockMovementSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
    invoiceNumber: { type: String, default: '', trim: true },
    type: {
      type: String,
      enum: ['initial_stock', 'sale', 'oversell', 'invoice_deleted', 'manual_adjustment'],
      required: true
    },
    quantityChange: { type: Number, required: true },
    stockBefore: { type: Number, required: true },
    stockAfter: { type: Number, required: true },
    note: { type: String, default: '', trim: true, maxlength: 500 }
  },
  { timestamps: true }
);

stockMovementSchema.index({ user: 1, product: 1, createdAt: -1 });
stockMovementSchema.index({ user: 1, invoice: 1 });

const StockMovement = mongoose.model('StockMovement', stockMovementSchema);

export default StockMovement;
