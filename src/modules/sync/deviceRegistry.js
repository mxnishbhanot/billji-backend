import DeviceSeries from '../../models/DeviceSeries.js';
import NumberSequence from '../../models/NumberSequence.js';
import {
  MAX_DEVICE_INDEX,
  PRIMARY_DEVICE_INDEX,
  deviceSegment,
  documentPrefixFor,
  financialYearFor,
  formatDeviceDocumentNumber,
  parseDeviceDocumentNumber
} from '../../services/numberingService.js';
import { ApiError } from '../../utils/ApiError.js';

/**
 * Device registration and the numbering rules that hang off it.
 *
 * The server assigns a series, and thereafter *validates* rather than assigns: an offline
 * device mints its own numbers from that series and the server's job is to prove each one
 * belongs to the device that sent it, sits in the right financial year, and has not been
 * used. A client-supplied invoice number is untrusted input on a legally-binding field, so
 * none of these checks are optional.
 *
 * Everything here is keyed on the *server's* clock for the financial year. A phone whose
 * date is wrong — factory reset, dead battery, or deliberately rolled back to bill into a
 * closed year — must not be able to assert which FY a sale belongs to.
 */

const counterKey = (documentType, financialYear) => `${documentType}:${financialYear}`;

/** Lowest free index, so a business that retires a device does not burn segments needlessly. */
const nextFreeIndex = async (businessId) => {
  const taken = new Set(
    (await DeviceSeries.find({ business: businessId }).select('index').lean()).map((row) => row.index)
  );

  for (let index = PRIMARY_DEVICE_INDEX; index <= MAX_DEVICE_INDEX; index += 1) {
    if (!taken.has(index)) return index;
  }

  throw new ApiError(422, `This business has used all ${MAX_DEVICE_INDEX} device numbering series`, {
    code: 'DEVICE_SERIES_EXHAUSTED'
  });
};

/**
 * Registers a device, or returns the series it already holds. Idempotent by `deviceId`: a
 * reinstall that kept its id keeps its series, which matters because that series is on
 * invoices already in customers' hands.
 */
export const registerDevice = async ({ business, user, deviceId, name = '', platform = '', documentType = 'invoice' }) => {
  if (!deviceId) throw new ApiError(422, 'A device id is required to allocate a numbering series', { code: 'DEVICE_ID_REQUIRED' });

  let device = await DeviceSeries.findOne({ business: business._id, deviceId });

  if (device?.revokedAt) {
    throw new ApiError(403, 'This device has been revoked for this business', { code: 'DEVICE_REVOKED' });
  }

  if (!device) {
    // Two devices registering at once race for the same free index; the unique index on
    // (business, index) is what makes the loser retry rather than share a series.
    for (let attempt = 0; attempt < 3 && !device; attempt += 1) {
      try {
        device = await DeviceSeries.create({
          business: business._id,
          deviceId,
          index: await nextFreeIndex(business._id),
          name,
          platform,
          registeredBy: user?._id ?? null
        });
      } catch (error) {
        if (error.code !== 11000 || attempt === 2) throw error;
      }
    }
  } else {
    device.lastSeenAt = new Date();
    if (name) device.name = name;
    if (platform) device.platform = platform;
    await device.save();
  }

  const financialYear = financialYearFor(new Date());
  const prefix = documentPrefixFor(business, documentType);

  return {
    device,
    series: {
      deviceId,
      deviceIndex: device.index,
      segment: deviceSegment(device.index),
      documentType,
      prefix,
      financialYear,
      // Where the device's local counter must start. For device 1 this is the shared
      // sequence, which online invoicing keeps advancing, so re-reading it on every sync is
      // what keeps an offline number from colliding with one the web app already issued.
      currentSequence: await currentSequence({ business, device, documentType, financialYear }),
      maxDeviceIndex: MAX_DEVICE_INDEX
    }
  };
};

/** The last sequence issued in this device's series, 0 when it has issued none. */
export const currentSequence = async ({ business, device, documentType, financialYear }) => {
  if (device.index === PRIMARY_DEVICE_INDEX) {
    const sequence = await NumberSequence.findOne({
      business: business._id,
      documentType,
      financialYear
    }).lean();
    return sequence?.current ?? 0;
  }

  return device.counters?.get(counterKey(documentType, financialYear)) ?? 0;
};

const advance = async ({ business, device, documentType, financialYear, sequence, prefix, session }) => {
  if (device.index === PRIMARY_DEVICE_INDEX) {
    // $max, not $inc: the device is telling the shared series which number it has already
    // put on a customer's invoice, and the series must never hand that number out again.
    await NumberSequence.updateOne(
      { business: business._id, documentType, financialYear },
      { $max: { current: sequence }, $setOnInsert: { business: business._id, documentType, financialYear, prefix } },
      { upsert: true, session }
    );
    return;
  }

  await DeviceSeries.updateOne(
    { _id: device._id },
    { $max: { [`counters.${counterKey(documentType, financialYear)}`]: sequence } },
    { session }
  );
};

// A queued invoice is legitimately old — that is the whole point of an offline window, and its
// date is the date of the actual sale, so the financial year comes from the date rather than
// from when the push happened. A date in the *future* is the abuse: a device with its clock
// pushed forward would otherwise bill into the next financial year, which is a filing
// discrepancy no credit note fixes cleanly.
export const MAX_DOCUMENT_DATE_SKEW_MS = 24 * 60 * 60 * 1000;

export const assertPlausibleDocumentDate = (value, now = new Date()) => {
  if (!value) return;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(422, 'Document date is not a valid date', { code: 'DOCUMENT_DATE_INVALID' });
  }
  if (date.getTime() - now.getTime() > MAX_DOCUMENT_DATE_SKEW_MS) {
    throw new ApiError(422, 'Document date is in the future; check this device’s date and time', {
      code: 'DOCUMENT_DATE_IN_FUTURE',
      serverTime: now.toISOString()
    });
  }
};

/**
 * Checks a client-issued document number against the series the device actually owns.
 *
 * Everything it rejects is something that would otherwise become a compliance problem:
 * a number from another device's series, a number in the wrong financial year, one over
 * the 16-character limit, or one at or below a position this series has already issued —
 * which is a duplicate, and a duplicate invoice number is an integrity incident rather
 * than a validation error.
 */
export const assertDeviceDocumentNumber = async ({ business, device, documentType = 'invoice', documentNumber, date }) => {
  const parsed = parseDeviceDocumentNumber(documentNumber);
  if (!parsed) {
    throw new ApiError(422, `"${documentNumber}" is not a valid document number for this business`, {
      code: 'DOCUMENT_NUMBER_INVALID'
    });
  }

  const prefix = documentPrefixFor(business, documentType);
  // The server's clock decides the financial year, not the device's.
  const financialYear = financialYearFor(date || new Date());

  const expected = formatDeviceDocumentNumber({
    prefix,
    financialYear,
    deviceIndex: device.index,
    sequence: parsed.sequence
  });

  if (expected !== String(documentNumber).toUpperCase()) {
    throw new ApiError(
      422,
      `Document number "${documentNumber}" does not belong to this device's series (expected the shape "${expected}")`,
      { code: 'DOCUMENT_NUMBER_OUT_OF_SERIES', expected }
    );
  }

  const current = await currentSequence({ business, device, documentType, financialYear });
  if (parsed.sequence <= current) {
    throw new ApiError(
      409,
      `Document number "${documentNumber}" has already been issued in this series`,
      { code: 'DOCUMENT_NUMBER_DUPLICATE', currentSequence: current }
    );
  }

  return { ...parsed, prefix, financialYear, expected, current };
};

/** Records the number as issued. Called only after the document is safely written. */
export const commitDeviceDocumentNumber = ({ business, device, documentType = 'invoice', financialYear, sequence, prefix, session }) =>
  advance({ business, device, documentType, financialYear, sequence, prefix, session });

export const findDevice = (businessId, deviceId) =>
  deviceId ? DeviceSeries.findOne({ business: businessId, deviceId, revokedAt: null }) : Promise.resolve(null);

// -- Push hooks --------------------------------------------------------------------------

/**
 * The push-path guard for a document that arrives carrying its own number.
 *
 * A payload with no number is an ordinary server-numbered create and passes straight
 * through — that is the online path, and a device that has not registered a series yet
 * still uses it. A payload *with* a number is an invoice already printed and handed over
 * offline, so it is checked against the sending device's series before anything is written.
 */
export const guardPushedDocumentNumber = async (req, op, documentType = 'invoice') => {
  const documentNumber = op.payload?.documentNumber || op.payload?.invoiceNumber;
  if (!documentNumber) return null;

  assertPlausibleDocumentDate(op.payload?.date);

  const device = await findDevice(req.business._id, req.deviceId);
  if (!device) {
    throw new ApiError(422, 'This device has no numbering series; register it before pushing numbered documents', {
      code: 'DEVICE_NOT_REGISTERED'
    });
  }

  const claim = await assertDeviceDocumentNumber({
    business: req.business,
    device,
    documentType,
    documentNumber,
    date: op.payload?.date
  });

  return { device, documentType, ...claim };
};

/** Marks the claimed position as issued, once the document is written. */
export const commitPushedDocumentNumber = (req, claim) =>
  claim
    ? commitDeviceDocumentNumber({
        business: req.business,
        device: claim.device,
        documentType: claim.documentType,
        financialYear: claim.financialYear,
        sequence: claim.sequence,
        prefix: claim.prefix
      })
    : Promise.resolve();
