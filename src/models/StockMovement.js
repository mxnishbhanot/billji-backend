import mongoose from 'mongoose';

const stockMovementSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    salesDocument: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesDocument', default: null, index: true },
    documentType: { type: String, default: '', trim: true },
    documentNumber: { type: String, default: '', trim: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
    invoiceNumber: { type: String, default: '', trim: true },
    type: {
      type: String,
      enum: [
        'opening_stock',
        'purchase',
        'sale',
        'sale_cancelled',
        'return',
        'manual_adjustment',
        'stock_correction',
        'initial_stock',
        'oversell',
        'invoice_deleted',
        'reservation',
        'reservation_released'
      ],
      required: true
    },
    quantityChange: { type: Number, required: true },
    stockBefore: { type: Number, required: true },
    stockAfter: { type: Number, required: true },
    note: { type: String, default: '', trim: true, maxlength: 500 }
  },
  { timestamps: true }
);

stockMovementSchema.pre('validate', function syncMovementCompatibility(next) {
  if (!this.documentNumber && this.invoiceNumber) {
    this.documentNumber = this.invoiceNumber;
  }

  if (!this.invoiceNumber && this.documentType === 'invoice' && this.documentNumber) {
    this.invoiceNumber = this.documentNumber;
  }

  next();
});

stockMovementSchema.index({ business: 1, product: 1, createdAt: -1 });
stockMovementSchema.index({ business: 1, salesDocument: 1 });
stockMovementSchema.index({ business: 1, invoice: 1 });

const StockMovement = mongoose.model('StockMovement', stockMovementSchema);

export default StockMovement;
