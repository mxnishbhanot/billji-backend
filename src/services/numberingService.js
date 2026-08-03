import NumberSequence from '../models/NumberSequence.js';
import { ApiError } from '../utils/ApiError.js';

// CGST Rule 46(b): a tax invoice's serial number may not exceed sixteen characters.
// The rendered format is `PREFIX-2026-27-0001` — 1 separator, a 7-character financial
// year, another separator, and a 4-digit sequence — so the prefix has 3 characters to
// work with. Businesses configured with a longer prefix have been issuing non-compliant
// numbers; scripts/audit-document-number-length.mjs finds them.
export const GST_DOCUMENT_NUMBER_MAX_LENGTH = 16;
const FINANCIAL_YEAR_LENGTH = 7;
const MIN_SEQUENCE_LENGTH = 4;
export const MAX_DOCUMENT_PREFIX_LENGTH =
  GST_DOCUMENT_NUMBER_MAX_LENGTH - FINANCIAL_YEAR_LENGTH - MIN_SEQUENCE_LENGTH - 2;

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

// ponytail: the guard rejects rather than truncates — a truncated serial number is a
// duplicate serial number, which is worse than a blocked invoice. It fires on two inputs:
// an over-long prefix (fix the prefix in Settings) and a sequence past 9999 in one
// financial year (needs the shorter format the offline design specifies in section 9).
export const formatDocumentNumber = ({ prefix, financialYear, sequence }) => {
  const documentNumber = `${prefix}-${financialYear}-${padSequence(sequence)}`;

  if (documentNumber.length > GST_DOCUMENT_NUMBER_MAX_LENGTH) {
    throw new ApiError(
      422,
      `Document number "${documentNumber}" is ${documentNumber.length} characters. GST allows at most ${GST_DOCUMENT_NUMBER_MAX_LENGTH}. Shorten the prefix in Settings to ${MAX_DOCUMENT_PREFIX_LENGTH} characters or fewer.`,
      { code: 'DOCUMENT_NUMBER_TOO_LONG' }
    );
  }

  return documentNumber;
};

// -- Device series ---------------------------------------------------------------------
//
// A device issues invoices offline from its own series, because a number printed for a
// customer can never be changed afterwards and a device with no signal cannot ask the
// server for one. GST allows concurrent series, so each device is a series.
//
// Device 1 is the business's existing series and renders unchanged, which is why a
// single-device business sees nothing new. Device 2 and up need a segment, and the
// 16-character budget has no room for one next to a 7-character financial year:
//
//   INV-2026-27-0001   16   device 1, today's format
//   INV-2627-D2-0001   16   device 2, compressed FY + one base-36 segment character
//
// One character of segment is 34 additional devices per business (D2..DZ). A business
// churning past that needs a reclamation policy, which is why registration fails loudly
// rather than wrapping.
export const PRIMARY_DEVICE_INDEX = 1;
export const MAX_DEVICE_INDEX = 35;

/** `2026-27` -> `2627`. Four characters, still unambiguous within a century. */
export const compactFinancialYear = (financialYear) => {
  const [start, end] = String(financialYear).split('-');
  return `${String(start).slice(-2)}${end}`;
};

/** 2 -> `D2`, 12 -> `DC`. Index 1 has no segment: it is the unsegmented series. */
export const deviceSegment = (index) => {
  if (index === PRIMARY_DEVICE_INDEX) return '';
  if (!Number.isInteger(index) || index < 1 || index > MAX_DEVICE_INDEX) {
    throw new ApiError(422, `Device series index ${index} is outside 1..${MAX_DEVICE_INDEX}`, {
      code: 'DEVICE_SERIES_EXHAUSTED'
    });
  }
  return `D${index.toString(36).toUpperCase()}`;
};

/**
 * The number a given device issues for a given sequence position. Device 1 falls through to
 * the existing format so nothing about the shared series changes.
 */
export const formatDeviceDocumentNumber = ({ prefix, financialYear, deviceIndex = PRIMARY_DEVICE_INDEX, sequence }) => {
  if (deviceIndex === PRIMARY_DEVICE_INDEX) return formatDocumentNumber({ prefix, financialYear, sequence });

  const documentNumber = `${prefix}-${compactFinancialYear(financialYear)}-${deviceSegment(deviceIndex)}-${padSequence(sequence)}`;

  if (documentNumber.length > GST_DOCUMENT_NUMBER_MAX_LENGTH) {
    throw new ApiError(
      422,
      `Document number "${documentNumber}" is ${documentNumber.length} characters. GST allows at most ${GST_DOCUMENT_NUMBER_MAX_LENGTH}. Shorten the prefix in Settings to ${MAX_DOCUMENT_PREFIX_LENGTH} characters or fewer.`,
      { code: 'DOCUMENT_NUMBER_TOO_LONG' }
    );
  }

  return documentNumber;
};

/**
 * Reads a device-issued number back. Returns null for anything that is not one of ours —
 * the caller treats that as "this device did not mint this number" and rejects it, because
 * a client-supplied invoice number is untrusted input on a compliance-critical field.
 */
export const parseDeviceDocumentNumber = (documentNumber) => {
  const match = /^(.+)-(\d{4}-\d{2}|\d{4})(?:-D([0-9A-Z]))?-(\d{4})$/.exec(String(documentNumber || '').toUpperCase());
  if (!match) return null;

  const [, prefix, year, segment, sequence] = match;
  return {
    prefix,
    // Both formats normalise to the canonical `2026-27`, so a caller compares one shape.
    financialYear: year.length === 4 ? `20${year.slice(0, 2)}-${year.slice(2)}` : year,
    compact: year.length === 4,
    deviceIndex: segment ? parseInt(segment, 36) : PRIMARY_DEVICE_INDEX,
    sequence: Number(sequence)
  };
};

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
