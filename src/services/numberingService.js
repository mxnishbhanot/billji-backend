import NumberSequence from '../models/NumberSequence.js';

const padSequence = (value) => String(value).padStart(4, '0');

export const financialYearFor = (date = new Date()) => {
  const value = new Date(date);
  const startYear = value.getMonth() >= 3 ? value.getFullYear() : value.getFullYear() - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
};

export const formatDocumentNumber = ({ prefix, financialYear, sequence }) =>
  `${prefix}-${financialYear}-${padSequence(sequence)}`;

export const nextDocumentNumber = async ({ business, documentType = 'invoice', date = new Date(), session }) => {
  const prefix = business?.invoicePrefix || 'INV';
  const financialYear = financialYearFor(date);
  const sequence = await NumberSequence.findOneAndUpdate(
    { business: business._id, documentType, financialYear },
    {
      $setOnInsert: {
        business: business._id,
        documentType,
        financialYear
      },
      $set: { prefix },
      $inc: { current: 1 }
    },
    { new: true, upsert: true, session }
  );

  return formatDocumentNumber({ prefix: sequence.prefix, financialYear: sequence.financialYear, sequence: sequence.current });
};

export const previewDocumentNumber = async ({ business, documentType = 'invoice', date = new Date() }) => {
  const prefix = business?.invoicePrefix || 'INV';
  const financialYear = financialYearFor(date);
  const sequence = await NumberSequence.findOne({ business: business._id, documentType, financialYear }).lean();

  return formatDocumentNumber({ prefix, financialYear, sequence: (sequence?.current || 0) + 1 });
};
