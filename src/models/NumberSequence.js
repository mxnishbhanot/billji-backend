import mongoose from 'mongoose';

const numberSequenceSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    documentType: { type: String, required: true, trim: true, lowercase: true, maxlength: 40 },
    financialYear: { type: String, required: true, trim: true, maxlength: 12 },
    prefix: { type: String, required: true, trim: true, uppercase: true, maxlength: 12 },
    current: { type: Number, required: true, default: 0, min: 0 }
  },
  { timestamps: true }
);

numberSequenceSchema.index({ business: 1, documentType: 1, financialYear: 1 }, { unique: true });

const NumberSequence = mongoose.model('NumberSequence', numberSequenceSchema);

export default NumberSequence;
