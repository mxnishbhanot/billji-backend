import { toCsv } from '../exports/csv.js';

// Column layouts follow the government offline-tool section names, so a CA can map these
// straight across. Reuses the existing RFC 4180 writer (BOM included, so Excel opens
// customer names in any script correctly).
const isoDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

const RATE_COLUMNS = [
  { header: 'Rate', path: 'rate' },
  { header: 'Taxable Value', path: 'taxableValue' },
  { header: 'Integrated Tax', path: 'igst' },
  { header: 'Central Tax', path: 'cgst' },
  { header: 'State/UT Tax', path: 'sgst' },
  { header: 'Cess', value: () => 0 }
];

// B2B and B2CL are per invoice per rate, so the document header repeats on each rate row.
const documentRows = (documents, { withGstin = false } = {}) =>
  documents.flatMap((document) =>
    document.items.map((item) => ({
      ...(withGstin ? { gstin: document.gstin } : {}),
      customerName: document.customerName,
      invoiceNumber: document.invoiceNumber,
      invoiceDate: isoDate(document.invoiceDate),
      invoiceValue: document.invoiceValue,
      placeOfSupply: document.placeOfSupplyCode ? `${document.placeOfSupplyCode}-${document.placeOfSupply}` : '',
      reverseCharge: document.reverseCharge,
      rate: item.rate,
      taxableValue: item.taxableValue,
      igst: item.igst,
      cgst: item.cgst,
      sgst: item.sgst
    }))
  );

export const GSTR1_SECTIONS = {
  b2b: {
    label: 'B2B',
    rows: (report) => documentRows(report.sections.b2b, { withGstin: true }),
    columns: [
      { header: 'GSTIN/UIN of Recipient', path: 'gstin' },
      { header: 'Receiver Name', path: 'customerName' },
      { header: 'Invoice Number', path: 'invoiceNumber' },
      { header: 'Invoice date', path: 'invoiceDate' },
      { header: 'Invoice Value', path: 'invoiceValue' },
      { header: 'Place Of Supply', path: 'placeOfSupply' },
      { header: 'Reverse Charge', path: 'reverseCharge' },
      { header: 'Invoice Type', value: () => 'Regular B2B' },
      ...RATE_COLUMNS
    ]
  },
  b2cl: {
    label: 'B2CL',
    rows: (report) => documentRows(report.sections.b2cl),
    columns: [
      { header: 'Invoice Number', path: 'invoiceNumber' },
      { header: 'Invoice date', path: 'invoiceDate' },
      { header: 'Invoice Value', path: 'invoiceValue' },
      { header: 'Place Of Supply', path: 'placeOfSupply' },
      ...RATE_COLUMNS
    ]
  },
  b2cs: {
    label: 'B2CS',
    rows: (report) =>
      report.sections.b2cs.map((row) => ({
        ...row,
        placeOfSupply: row.placeOfSupplyCode ? `${row.placeOfSupplyCode}-${row.placeOfSupply}` : ''
      })),
    columns: [
      // 'OE' = other than e-commerce. BillJi has no e-commerce operator flow, so every
      // B2CS row is OE; revisit when marketplace sales exist.
      { header: 'Type', value: () => 'OE' },
      { header: 'Place Of Supply', path: 'placeOfSupply' },
      ...RATE_COLUMNS,
      { header: 'Invoice Count', path: 'invoiceCount' }
    ]
  },
  cdnr: {
    label: 'CDNR',
    rows: (report) =>
      report.sections.cdnr.flatMap((note) =>
        note.items.map((item) => ({
          gstin: note.gstin,
          customerName: note.customerName,
          noteNumber: note.noteNumber,
          noteDate: isoDate(note.noteDate),
          originalInvoiceNumber: note.originalInvoiceNumber,
          originalInvoiceDate: isoDate(note.originalInvoiceDate),
          documentType: note.documentType,
          noteValue: note.noteValue,
          placeOfSupply: note.placeOfSupplyCode ? `${note.placeOfSupplyCode}-${note.placeOfSupply}` : '',
          rate: item.rate,
          taxableValue: item.taxableValue,
          igst: item.igst,
          cgst: item.cgst,
          sgst: item.sgst
        }))
      ),
    columns: [
      { header: 'GSTIN/UIN of Recipient', path: 'gstin' },
      { header: 'Receiver Name', path: 'customerName' },
      { header: 'Invoice/Advance Receipt Number', path: 'originalInvoiceNumber' },
      { header: 'Invoice/Advance Receipt date', path: 'originalInvoiceDate' },
      { header: 'Note/Refund Voucher Number', path: 'noteNumber' },
      { header: 'Note/Refund Voucher date', path: 'noteDate' },
      { header: 'Document Type', path: 'documentType' },
      { header: 'Place Of Supply', path: 'placeOfSupply' },
      { header: 'Note/Refund Voucher Value', path: 'noteValue' },
      ...RATE_COLUMNS
    ]
  },
  hsn: {
    label: 'HSN',
    rows: (report) => report.sections.hsn,
    columns: [
      { header: 'HSN', path: 'hsn' },
      { header: 'Rate', path: 'rate' },
      { header: 'Total Taxable Value', path: 'taxableValue' },
      { header: 'Integrated Tax Amount', path: 'igst' },
      { header: 'Central Tax Amount', path: 'cgst' },
      { header: 'State/UT Tax Amount', path: 'sgst' },
      { header: 'Cess Amount', value: () => 0 }
    ]
  }
};

export const GSTR1_SECTION_KEYS = Object.keys(GSTR1_SECTIONS);

export const gstr1SectionCsv = (report, sectionKey) => {
  const section = GSTR1_SECTIONS[sectionKey];
  return toCsv(section.rows(report), section.columns);
};

export const gstr3bCsv = (report) =>
  toCsv(
    [
      {
        nature: 'Outward taxable supplies (other than zero rated, nil rated and exempted)',
        ...report.outwardTaxableSupplies
      }
    ],
    [
      { header: 'Nature of Supplies', path: 'nature' },
      { header: 'Total Taxable Value', path: 'taxableValue' },
      { header: 'Integrated Tax', path: 'igst' },
      { header: 'Central Tax', path: 'cgst' },
      { header: 'State/UT Tax', path: 'sgst' },
      { header: 'Cess', path: 'cess' }
    ]
  );
