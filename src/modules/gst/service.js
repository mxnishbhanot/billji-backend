import Invoice from '../../models/Invoice.js';
import { stateCodeFromGstin, stateNameForCode } from '../../constants/gstStates.js';
import { ApiError } from '../../utils/ApiError.js';

// GSTR-1 section rules (as filed today):
//  B2B  — recipient is GST-registered, regardless of value or state.
//  B2CL — unregistered recipient, inter-state, invoice value above the threshold.
//  B2CS — every other unregistered sale, aggregated by (state, rate) rather than listed.
// The threshold moved from 2.5L to 1L for invoices issued on/after 1 Aug 2024.
const B2CL_THRESHOLD_CURRENT = 100000;
const B2CL_THRESHOLD_LEGACY = 250000;
const B2CL_THRESHOLD_CHANGE_DATE = new Date('2024-08-01T00:00:00.000Z');

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const b2clThresholdFor = (date) =>
  new Date(date) >= B2CL_THRESHOLD_CHANGE_DATE ? B2CL_THRESHOLD_CURRENT : B2CL_THRESHOLD_LEGACY;

/** 'YYYY-MM' -> inclusive month window. Throws on anything else so a typo can't file a wrong period. */
export const parsePeriod = (period) => {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period || '').trim());
  if (!match) throw new ApiError(422, 'Period must be in YYYY-MM format');

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new ApiError(422, 'Period month must be between 01 and 12');

  return {
    period: `${match[1]}-${match[2]}`,
    // GST periods are calendar months in local time, matching how invoice dates are stored.
    from: new Date(year, month - 1, 1),
    to: new Date(year, month, 1)
  };
};

/**
 * Rate-wise rows for one document, derived from the stored taxSummary.
 *
 * Documents issued before the GST engine have no taxSummary; they are reconstructed from
 * the single document-level rate so a historical month still files rather than silently
 * reporting zero.
 */
const rateRowsFor = (invoice) => {
  const summary = Array.isArray(invoice.taxSummary) ? invoice.taxSummary : [];

  if (summary.length) {
    return summary.map((row) => ({
      hsn: row.hsn || '',
      rate: Number(row.rate || 0),
      taxableValue: money(row.taxableValue),
      cgst: money(row.cgst),
      sgst: money(row.sgst),
      igst: money(row.igst),
      taxAmount: money(row.taxAmount)
    }));
  }

  const rate = Number(invoice.tax?.rate || 0);
  const taxAmount = money(invoice.tax?.amount);
  const taxableValue = money(Number(invoice.subtotal || 0) - Number(invoice.discount?.amount || 0));
  const isInter = invoice.supplyType === 'inter';

  return [
    {
      hsn: '',
      rate,
      taxableValue,
      cgst: isInter ? 0 : money(taxAmount / 2),
      sgst: isInter ? 0 : money(taxAmount - money(taxAmount / 2)),
      igst: isInter ? taxAmount : 0,
      taxAmount,
      // Flagged so the UI can warn that this month contains pre-GST-engine documents.
      reconstructed: true
    }
  ];
};

const recipientGstin = (invoice) =>
  (invoice.customerSnapshot?.taxIdentifiers?.gstNumber || invoice.customerSnapshot?.gstNumber || '').trim().toUpperCase();

const placeOfSupplyFor = (invoice) => {
  const code = invoice.placeOfSupply?.code || stateCodeFromGstin(recipientGstin(invoice)) || '';
  return { code, state: invoice.placeOfSupply?.state || stateNameForCode(code) };
};

/**
 * Builds GSTR-1 for one month.
 *
 * Only issued invoices count. Cancelled and void documents are excluded outright rather
 * than reported as credit notes — cancelling in BillJi reverses the document entirely
 * (stock and ledger), so it was never a supply. A genuine post-supply reversal is a
 * credit note, which arrives with Phase 6 and will file under CDNR.
 */
export const buildGstr1 = async (business, periodInput) => {
  const { period, from, to } = parsePeriod(periodInput);

  const invoices = await Invoice.find({
    business: business._id,
    documentType: 'invoice',
    documentStatus: 'issued',
    date: { $gte: from, $lt: to }
  })
    .sort({ date: 1, invoiceNumber: 1 })
    .lean();

  const b2b = [];
  const b2cl = [];
  const b2csByKey = new Map();
  const hsnByKey = new Map();
  let reconstructedCount = 0;

  for (const invoice of invoices) {
    const rows = rateRowsFor(invoice);
    if (rows.some((row) => row.reconstructed)) reconstructedCount += 1;

    const gstin = recipientGstin(invoice);
    const placeOfSupply = placeOfSupplyFor(invoice);
    const isInter = invoice.supplyType === 'inter';
    const threshold = b2clThresholdFor(invoice.date);

    // HSN summary spans every section — it is the whole month's supplies by HSN and rate.
    for (const row of rows) {
      const hsnKey = `${row.hsn}|${row.rate}`;
      const hsnRow = hsnByKey.get(hsnKey) || { hsn: row.hsn, rate: row.rate, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, taxAmount: 0 };
      hsnRow.taxableValue = money(hsnRow.taxableValue + row.taxableValue);
      hsnRow.cgst = money(hsnRow.cgst + row.cgst);
      hsnRow.sgst = money(hsnRow.sgst + row.sgst);
      hsnRow.igst = money(hsnRow.igst + row.igst);
      hsnRow.taxAmount = money(hsnRow.taxAmount + row.taxAmount);
      hsnByKey.set(hsnKey, hsnRow);
    }

    const documentHeader = {
      invoiceNumber: invoice.invoiceNumber || invoice.documentNumber,
      invoiceDate: invoice.date,
      invoiceValue: money(invoice.total),
      placeOfSupplyCode: placeOfSupply.code,
      placeOfSupply: placeOfSupply.state,
      supplyType: isInter ? 'inter' : 'intra',
      reverseCharge: 'N',
      customerName: invoice.customerSnapshot?.name || ''
    };

    if (gstin) {
      b2b.push({ ...documentHeader, gstin, items: rows });
      continue;
    }

    if (isInter && Number(invoice.total || 0) > threshold) {
      b2cl.push({ ...documentHeader, items: rows });
      continue;
    }

    // B2CS is aggregated by (place of supply, rate), never itemised per invoice.
    const countedKeys = new Set();
    for (const row of rows) {
      const key = `${placeOfSupply.code}|${row.rate}|${isInter ? 'inter' : 'intra'}`;
      const bucket =
        b2csByKey.get(key) ||
        {
          placeOfSupplyCode: placeOfSupply.code,
          placeOfSupply: placeOfSupply.state,
          rate: row.rate,
          supplyType: isInter ? 'inter' : 'intra',
          taxableValue: 0,
          cgst: 0,
          sgst: 0,
          igst: 0,
          taxAmount: 0,
          invoiceCount: 0
        };
      bucket.taxableValue = money(bucket.taxableValue + row.taxableValue);
      bucket.cgst = money(bucket.cgst + row.cgst);
      bucket.sgst = money(bucket.sgst + row.sgst);
      bucket.igst = money(bucket.igst + row.igst);
      bucket.taxAmount = money(bucket.taxAmount + row.taxAmount);
      // A mixed-rate invoice lands in several buckets but counts once in each.
      if (!countedKeys.has(key)) {
        bucket.invoiceCount += 1;
        countedKeys.add(key);
      }
      b2csByKey.set(key, bucket);
    }
  }

  // Document series: the numbers issued this month, including cancelled ones, which the
  // return has to account for even though they carry no value.
  const cancelledCount = await Invoice.countDocuments({
    business: business._id,
    documentType: 'invoice',
    documentStatus: { $in: ['cancelled', 'void'] },
    date: { $gte: from, $lt: to }
  });

  // CDNR: credit notes issued this month, listed against the invoice each one reverses.
  // Values stay positive here — the return form treats the section itself as a reduction.
  const creditNotes = await Invoice.find({
    business: business._id,
    documentType: 'credit_note',
    documentStatus: 'issued',
    date: { $gte: from, $lt: to }
  })
    .sort({ date: 1, documentNumber: 1 })
    .populate('sourceInvoice', 'invoiceNumber date')
    .lean();

  const cdnr = creditNotes.map((note) => {
    const rows = rateRowsFor(note);
    const placeOfSupply = placeOfSupplyFor(note);
    return {
      gstin: recipientGstin(note),
      customerName: note.customerSnapshot?.name || '',
      noteNumber: note.documentNumber,
      noteDate: note.date,
      noteValue: money(note.total),
      // Which supply is being undone — the return is rejected without it.
      originalInvoiceNumber: note.sourceInvoice?.invoiceNumber || '',
      originalInvoiceDate: note.sourceInvoice?.date || null,
      placeOfSupplyCode: placeOfSupply.code,
      placeOfSupply: placeOfSupply.state,
      supplyType: note.supplyType === 'inter' ? 'inter' : 'intra',
      documentType: 'C',
      reason: note.reason || '',
      items: rows
    };
  });

  const sections = { b2b, b2cl, b2cs: [...b2csByKey.values()], cdnr, hsn: [...hsnByKey.values()] };
  const sumRows = (rows, key) => money(rows.reduce((sum, row) => sum + Number(row[key] || 0), 0));
  const creditRows = cdnr.flatMap((note) => note.items);

  const totals = {
    invoiceCount: invoices.length,
    cancelledCount,
    taxableValue: sumRows(sections.hsn, 'taxableValue'),
    cgst: sumRows(sections.hsn, 'cgst'),
    sgst: sumRows(sections.hsn, 'sgst'),
    igst: sumRows(sections.hsn, 'igst'),
    taxAmount: sumRows(sections.hsn, 'taxAmount'),
    invoiceValue: money(invoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0)),
    // Credit notes are reported as their own section, so they are kept separate here
    // rather than folded into the supply figures. GSTR-3B nets them off.
    creditNoteCount: cdnr.length,
    creditNoteTaxableValue: sumRows(creditRows, 'taxableValue'),
    creditNoteCgst: sumRows(creditRows, 'cgst'),
    creditNoteSgst: sumRows(creditRows, 'sgst'),
    creditNoteIgst: sumRows(creditRows, 'igst'),
    creditNoteTaxAmount: sumRows(creditRows, 'taxAmount')
  };

  return {
    period,
    gstin: (business.gstNumber || '').toUpperCase(),
    businessName: business.businessName || '',
    sections,
    counts: {
      b2b: b2b.length,
      b2cl: b2cl.length,
      b2cs: sections.b2cs.length,
      cdnr: cdnr.length,
      hsn: sections.hsn.length
    },
    totals,
    // Non-zero means the month mixes pre-GST-engine invoices whose split was inferred
    // from a single document rate. Worth a warning before filing.
    reconstructedInvoices: reconstructedCount,
    documentSeries: {
      issued: invoices.length,
      cancelled: cancelledCount,
      from: invoices[0]?.invoiceNumber || '',
      to: invoices[invoices.length - 1]?.invoiceNumber || ''
    }
  };
};

/**
 * GSTR-3B table 3.1(a): outward taxable supplies, one line per tax head.
 *
 * Reported net of credit notes — 3.1(a) is a liability figure, and a credit note reduces
 * the liability for the month it was issued in. GSTR-1 keeps them as a separate CDNR
 * section instead, which is why the two views differ.
 */
export const buildGstr3b = async (business, periodInput) => {
  const report = await buildGstr1(business, periodInput);
  const { totals } = report;
  const net = (gross, credit) => money(Number(gross || 0) - Number(credit || 0));

  return {
    period: report.period,
    gstin: report.gstin,
    businessName: report.businessName,
    outwardTaxableSupplies: {
      taxableValue: net(totals.taxableValue, totals.creditNoteTaxableValue),
      igst: net(totals.igst, totals.creditNoteIgst),
      cgst: net(totals.cgst, totals.creditNoteCgst),
      sgst: net(totals.sgst, totals.creditNoteSgst),
      cess: 0
    },
    invoiceCount: totals.invoiceCount,
    cancelledCount: totals.cancelledCount,
    creditNoteCount: totals.creditNoteCount,
    reconstructedInvoices: report.reconstructedInvoices
  };
};
