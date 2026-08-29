// Every value a rendered invoice needs, derived once and shared by both renderers:
// the React PDF document (InvoiceDocument.js) and the HTML preview (invoiceHtml.js).
// Nothing here calculates money — totals, GST, discounts and the tax summary all
// arrive already computed by utils/invoiceMath.js. This module only decides what
// gets printed and how it reads.

export const currency = (value) =>
  `Rs. ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const statusText = (value = '') => String(value || '').replace(/_/g, ' ').toUpperCase();

export const joinLines = (lines = []) => lines.filter(Boolean).map((line) => String(line).trim()).filter(Boolean);

const businessAddress = (business = {}) =>
  joinLines([business.address, joinLines([business.city, business.state, business.pinCode]).join(', '), business.website]);

const customerAddress = (customer = {}) => {
  const billing = customer.billingAddress || {};
  const structured = joinLines([billing.line1, billing.line2, joinLines([billing.city, billing.state, billing.pinCode]).join(', ')]);
  return structured.length ? structured : joinLines([customer.address]);
};

const customerTaxLabel = (customer = {}) => {
  if (customer.gstNumber || customer.taxIdentifiers?.gstNumber) return `GSTIN: ${customer.gstNumber || customer.taxIdentifiers.gstNumber}`;
  if (customer.taxIdentifiers?.panNumber) return `PAN: ${customer.taxIdentifiers.panNumber}`;
  return '';
};

const hexToRgb = (hex) => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = match ? parseInt(match[1], 16) : 0x4338ca;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

export const tint = (hex, ratio) => {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c) => Math.round(c + (255 - c) * ratio);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
};

// Shown under NOTES & TERMS when the business hasn't set its own default notes
// and the invoice itself carries none. Exported so the app can pre-fill the
// settings field with the same copy.
export const DEFAULT_INVOICE_NOTES = 'Thank you for your business!';

export const resolveTemplate = (business = {}) => {
  const tpl = business.invoiceTemplate || {};
  return {
    accentColor: /^#[0-9a-fA-F]{6}$/.test(tpl.accentColor || '') ? tpl.accentColor : '#4338CA',
    showLogo: tpl.showLogo !== false,
    showNotes: tpl.showNotes !== false,
    showSignature: tpl.showSignature === true,
    signatureUrl: typeof tpl.signatureUrl === 'string' ? tpl.signatureUrl : '',
    showPaymentRows: tpl.showPaymentRows !== false,
    notes: typeof tpl.notes === 'string' ? tpl.notes.trim() : ''
  };
};

// Only an inline base64 PNG/JPEG can be embedded — a remote URL would need a network
// fetch mid-render, and React PDF supports neither SVG sources nor other raster formats.
export const isLogoData = (logoUrl = '') => /^data:image\/(?:png|jpe?g);base64,/i.test(logoUrl);

// Per-document identity. A quotation or challan must never be mistaken for the tax
// invoice — buyers routinely forward a quote internally for approval, so it carries a
// diagonal watermark and an explicit "not a tax invoice" line as well as its own title.
export const DOCUMENT_META = {
  invoice: { title: 'INVOICE', noun: 'invoice' },
  quotation: {
    title: 'QUOTATION',
    noun: 'quotation',
    watermark: 'QUOTATION',
    disclaimer:
      'This is a quotation, not a tax invoice or a bill. No goods or services have been supplied and no payment is due against this document. A tax invoice will be issued separately once this quotation is approved and the order is placed. Prices and availability are subject to change until then.'
  },
  delivery_challan: {
    title: 'DELIVERY CHALLAN',
    noun: 'delivery challan',
    watermark: 'CHALLAN',
    disclaimer:
      'This is a delivery challan, not a tax invoice or a bill. It accompanies the goods listed above; the amounts shown are for reference only. A tax invoice will be issued separately for payment.'
  },
  credit_note: { title: 'CREDIT NOTE', noun: 'credit note' }
};

export const metaFor = (documentType) => DOCUMENT_META[documentType] || DOCUMENT_META.invoice;

/**
 * Turns a calculated invoice plus its business context into the printable view both
 * renderers walk: text already formatted, rows already ordered, sections already
 * decided. Renderers position these values; they never derive them.
 */
export const deriveDocumentView = (invoice = {}, businessContext = {}, options = {}) => {
  const business = businessContext?.businessProfile || businessContext || {};
  const template = resolveTemplate(business);
  const accent = template.accentColor;
  const customer = invoice.customerSnapshot || {};
  const doc = metaFor(invoice.documentType || options.documentType);
  // Paid / balance / payment status only mean something on a tax invoice. Printing them
  // on a quotation reads as money already owed.
  const showPaymentRows = template.showPaymentRows && doc.noun === 'invoice';

  // paymentStatus is authoritative: a 'paid' invoice always renders fully paid and
  // 'unpaid' renders zero, even if the denormalized paidAmount/balanceDue are stale
  // or missing. Only 'partial' trusts the stored amount.
  const invoiceTotal = Number(invoice.total || 0);
  const paymentStatus = invoice.paymentStatus;
  // Credit settles the invoice without money arriving, so a fully-settled invoice is not
  // necessarily fully *paid*: 'paid' means total - creditApplied was received, not total.
  // Printing the credit as cash would put a figure on the customer's copy that ties to no
  // receipt at all.
  const creditApplied = paymentStatus === 'unpaid' ? 0 : Number(invoice.creditApplied ?? 0);
  const paidAmount =
    paymentStatus === 'paid' ? Math.max(invoiceTotal - creditApplied, 0)
    : paymentStatus === 'unpaid' ? 0
    : Number(invoice.paidAmount ?? 0);
  const balanceDue =
    paymentStatus === 'paid' ? 0
    : Number(invoice.balanceDue ?? Math.max(invoiceTotal - paidAmount - creditApplied, 0));
  const discountAmount = Number(invoice.discount?.amount || 0);
  const taxAmount = Number(invoice.tax?.amount || 0);
  const taxRate = Number(invoice.tax?.rate || 0);

  // GST-aware rendering only when the document carries a tax summary. Invoices issued
  // before the GST engine have none and keep the exact layout they were printed with.
  const taxSummary = Array.isArray(invoice.taxSummary) ? invoice.taxSummary : [];
  const isGstDocument = taxSummary.length > 0;
  const isInterState = invoice.supplyType === 'inter';
  const showHsnColumn = isGstDocument && taxSummary.some((row) => row.hsn);
  const cgstTotal = taxSummary.reduce((sum, row) => sum + Number(row.cgst || 0), 0);
  const sgstTotal = taxSummary.reduce((sum, row) => sum + Number(row.sgst || 0), 0);
  const igstTotal = taxSummary.reduce((sum, row) => sum + Number(row.igst || 0), 0);

  // Due date is rarely set in-app, so it printed a meaningless "On receipt" on most
  // receipts. When there's no real due date, show the amount paid instead — concrete
  // info the customer can use.
  const dueDateText = formatDate(invoice.dueDate);
  const validUntilText = formatDate(invoice.validUntil);
  const metaCells = [['Issue date', formatDate(invoice.date) || '-']];

  if (doc.noun === 'invoice') {
    metaCells.push(dueDateText ? ['Due date', dueDateText] : ['Amount paid', currency(paidAmount)]);
    metaCells.push(['Payment', statusText(invoice.paymentStatus || invoice.status || 'unpaid')]);
    if (showPaymentRows) metaCells.push(['Balance', currency(balanceDue)]);
  } else {
    if (validUntilText) metaCells.push(['Valid until', validUntilText]);
    metaCells.push(['Document', doc.title]);
  }

  const fromLines = [
    joinLines([business.phone, business.email]).join('  |  '),
    ...businessAddress(business),
    business.gstNumber ? `GSTIN: ${business.gstNumber}` : '',
    business.panNumber ? `PAN: ${business.panNumber}` : '',
    // Place of supply belongs on the buyer-facing document; showing it beside the
    // supplier block keeps the meta row from overflowing on narrow A4 margins.
    isGstDocument && invoice.placeOfSupply?.state
      ? `Place of supply: ${invoice.placeOfSupply.state}${isInterState ? ' (inter-state)' : ''}`
      : ''
  ];
  const toLines = [joinLines([customer.phone, customer.email]).join('  |  '), ...customerAddress(customer), customerTaxLabel(customer)];

  const itemHeaders = ['Description', ...(showHsnColumn ? ['HSN/SAC'] : []), 'Qty', 'Rate', ...(isGstDocument ? ['GST'] : []), 'Amount'];

  const items = (invoice.items || []).map((item) => ({
    name: item.name,
    sku: item.sku || '',
    hsn: showHsnColumn ? item.hsn || '-' : null,
    quantity: String(item.unit ? `${item.quantity} ${item.unit}` : item.quantity),
    rate: currency(item.price),
    gst: isGstDocument ? `${Number(item.taxRate || 0)}%` : null,
    amount: currency(item.total)
  }));

  // HSN-wise tax breakup — required on a GST invoice and the same grouping GSTR-1 files.
  const taxSummaryHeaders = isGstDocument
    ? [
        showHsnColumn ? 'HSN/SAC' : 'Rate',
        ...(showHsnColumn ? ['Rate'] : []),
        'Taxable',
        ...(isInterState ? ['IGST'] : ['CGST', 'SGST']),
        'Total tax'
      ]
    : [];

  const taxSummaryRows = taxSummary.map((row) => [
    showHsnColumn ? row.hsn || '-' : `${Number(row.rate || 0)}%`,
    ...(showHsnColumn ? [`${Number(row.rate || 0)}%`] : []),
    currency(row.taxableValue),
    ...(isInterState ? [currency(row.igst)] : [currency(row.cgst), currency(row.sgst)]),
    currency(row.taxAmount)
  ]);

  const totalRows = [{ label: 'Subtotal', value: currency(invoice.subtotal) }];
  if (discountAmount > 0) totalRows.push({ label: 'Discount', value: `-${currency(discountAmount)}` });
  if (isGstDocument) {
    // A GST invoice must show the tax heads separately, never one merged "Tax" line.
    if (isInterState) {
      if (igstTotal > 0) totalRows.push({ label: 'IGST', value: currency(igstTotal) });
    } else {
      if (cgstTotal > 0) totalRows.push({ label: 'CGST', value: currency(cgstTotal) });
      if (sgstTotal > 0) totalRows.push({ label: 'SGST', value: currency(sgstTotal) });
    }
  } else if (taxAmount > 0 || taxRate > 0) {
    totalRows.push({ label: `Tax (${taxRate}%)`, value: currency(taxAmount) });
  }
  totalRows.push({ label: 'Total', value: currency(invoice.total), emphasis: true });
  if (showPaymentRows) totalRows.push({ label: 'Paid', value: currency(paidAmount) });
  if (showPaymentRows && creditApplied > 0) totalRows.push({ label: 'Credit applied', value: currency(creditApplied) });

  // Per-invoice notes win; else the business's saved default; else the built-in copy.
  const notes = (invoice.notes && invoice.notes.trim()) || template.notes || DEFAULT_INVOICE_NOTES;

  return {
    accent,
    accentTint: tint(accent, 0.9),
    doc,
    template,
    businessName: business.businessName || 'Your Business',
    customerName: customer.name || 'Customer',
    documentNumber: invoice.invoiceNumber || invoice.documentNumber || '-',
    logoUrl: template.showLogo && isLogoData(business.logoUrl) ? business.logoUrl : '',
    // With the signature block on, leave room for a handwritten signatory line.
    // With it off, state that the invoice is system-generated so the empty space
    // reads as intentional and professional instead of a missing signature.
    signatureUrl: template.showSignature && isLogoData(template.signatureUrl) ? template.signatureUrl : '',
    showSignature: template.showSignature,
    showNotes: template.showNotes,
    showPaymentRows,
    isGstDocument,
    isInterState,
    showHsnColumn,
    placeOfSupplyState: invoice.placeOfSupply?.state || '',
    metaCells,
    fromLines: joinLines(fromLines),
    toLines: joinLines(toLines),
    itemHeaders,
    items,
    taxSummaryHeaders,
    taxSummaryRows,
    totalRows,
    balanceRow: showPaymentRows ? { label: 'Balance due', value: currency(balanceDue) } : null,
    notes
  };
};
