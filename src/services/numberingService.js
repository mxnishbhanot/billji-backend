import NumberSequence from '../models/NumberSequence.js';

const padSequence = (value) => String(value).padStart(4, '0');
const padOrderSequence = (value) => String(value).padStart(6, '0');

// Orders are separate business documents: continuous counter, no financial-year segment.
// e.g. ORD-000001. Scoped under a constant so the sequence never resets per FY.
export const ORDER_NUMBER_PREFIX = 'ORD';
const ORDER_SEQUENCE_SCOPE = 'ALL';

export const formatOrderNumber = ({ prefix = ORDER_NUMBER_PREFIX, sequence }) =>
  `${prefix}-${padOrderSequence(sequence)}`;

export const financialYearFor = (date = new Date()) => {
  const value = new Date(date);
  const startYear = value.getMonth() >= 3 ? value.getFullYear() : value.getFullYear() - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
};

export const formatDocumentNumber = ({ prefix, financialYear, sequence }) =>
  `${prefix}-${financialYear}-${padSequence(sequence)}`;

// Each document type carries its own prefix (INV/QTN/DC/CN) and its own financial-year
// sequence, so the series stay separate as GST requires.
const PREFIX_FIELDS = {
  invoice: ['invoicePrefix', 'INV'],
  quotation: ['quotationPrefix', 'QTN'],
  delivery_challan: ['challanPrefix', 'DC'],
  credit_note: ['creditNotePrefix', 'CN'],
  purchase: ['purchasePrefix', 'PUR']
};

export const documentPrefixFor = (business, documentType = 'invoice') => {
  const [field, fallback] = PREFIX_FIELDS[documentType] || PREFIX_FIELDS.invoice;
  return business?.[field] || fallback;
};

export const nextDocumentNumber = async ({ business, documentType = 'invoice', date = new Date(), session }) => {
  const prefix = documentPrefixFor(business, documentType);
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

export const nextOrderNumber = async ({ business, session } = {}) => {
  const prefix = business?.orderPrefix || ORDER_NUMBER_PREFIX;
  const sequence = await NumberSequence.findOneAndUpdate(
    { business: business._id, documentType: 'order', financialYear: ORDER_SEQUENCE_SCOPE },
    {
      $setOnInsert: {
        business: business._id,
        documentType: 'order',
        financialYear: ORDER_SEQUENCE_SCOPE
      },
      $set: { prefix },
      $inc: { current: 1 }
    },
    { new: true, upsert: true, session }
  );

  return formatOrderNumber({ prefix: sequence.prefix, sequence: sequence.current });
};

export const previewOrderNumber = async ({ business } = {}) => {
  const prefix = business?.orderPrefix || ORDER_NUMBER_PREFIX;
  const sequence = await NumberSequence.findOne({
    business: business._id,
    documentType: 'order',
    financialYear: ORDER_SEQUENCE_SCOPE
  }).lean();

  return formatOrderNumber({ prefix, sequence: (sequence?.current || 0) + 1 });
};

export const previewDocumentNumber = async ({ business, documentType = 'invoice', date = new Date() }) => {
  const prefix = documentPrefixFor(business, documentType);
  const financialYear = financialYearFor(date);
  const sequence = await NumberSequence.findOne({ business: business._id, documentType, financialYear }).lean();

  return formatDocumentNumber({ prefix, financialYear, sequence: (sequence?.current || 0) + 1 });
};
