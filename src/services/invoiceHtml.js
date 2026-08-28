// Single source of truth for invoice rendering. The same HTML is used to produce
// the PDF (headless Chromium in pdfService) and the live mobile preview (WebView
// fetches it via the template-preview endpoint), so both are pixel-identical.

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const currency = (value) => `Rs. ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const statusText = (value = '') => String(value || '').replace(/_/g, ' ').toUpperCase();

const joinLines = (lines = []) => lines.filter(Boolean).map((line) => String(line).trim()).filter(Boolean);

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
const tint = (hex, ratio) => {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c) => Math.round(c + (255 - c) * ratio);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
};

// Shown under NOTES & TERMS when the business hasn't set its own default notes
// and the invoice itself carries none. Exported so the app can pre-fill the
// settings field with the same copy.
export const DEFAULT_INVOICE_NOTES = 'Thank you for your business!';

const resolveTemplate = (business = {}) => {
  const tpl = business.invoiceTemplate || {};
  return {
    accentColor: /^#[0-9a-fA-F]{6}$/.test(tpl.accentColor || '') ? tpl.accentColor : '#D95F18',
    showLogo: tpl.showLogo !== false,
    showNotes: tpl.showNotes !== false,
    showSignature: tpl.showSignature === true,
    signatureUrl: typeof tpl.signatureUrl === 'string' ? tpl.signatureUrl : '',
    showPaymentRows: tpl.showPaymentRows !== false,
    notes: typeof tpl.notes === 'string' ? tpl.notes.trim() : ''
  };
};

const isLogoData = (logoUrl = '') => /^data:image\/(?:png|jpe?g);base64,/i.test(logoUrl);

// Per-document identity. A quotation or challan must never be mistaken for the tax
// invoice — buyers routinely forward a quote internally for approval, so it carries a
// diagonal watermark and an explicit "not a tax invoice" line as well as its own title.
const DOCUMENT_META = {
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

const metaFor = (documentType) => DOCUMENT_META[documentType] || DOCUMENT_META.invoice;

const partyBlock = (label, lead, lines) => `
  <div class="party">
    <div class="party-label">${escapeHtml(label)}</div>
    <div class="party-name">${escapeHtml(lead)}</div>
    ${joinLines(lines).map((line) => `<div class="party-text">${escapeHtml(line)}</div>`).join('')}
  </div>`;

export const buildInvoiceHtml = (invoice = {}, businessContext = {}, options = {}) => {
  const business = businessContext?.businessProfile || businessContext || {};
  const tpl = resolveTemplate(business);
  const accent = tpl.accentColor;
  const customer = invoice.customerSnapshot || {};
  const doc = metaFor(invoice.documentType || options.documentType);
  // Paid / balance / payment status only mean something on a tax invoice. Printing them
  // on a quotation reads as money already owed.
  const showPaymentRows = tpl.showPaymentRows && doc.noun === 'invoice';

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

  const logoHtml = tpl.showLogo && isLogoData(business.logoUrl)
    ? `<img class="logo" src="${business.logoUrl}" alt="logo" />`
    : '';

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

  const itemsHtml = (invoice.items || [])
    .map(
      (item) => `
      <tr>
        <td class="c-desc">
          <div class="item-name">${escapeHtml(item.name)}</div>
          ${item.sku ? `<div class="item-sku">SKU: ${escapeHtml(item.sku)}</div>` : ''}
        </td>
        ${showHsnColumn ? `<td class="c-hsn">${escapeHtml(item.hsn || '-')}</td>` : ''}
        <td class="c-qty">${escapeHtml(item.unit ? `${item.quantity} ${item.unit}` : item.quantity)}</td>
        <td class="c-rate">${currency(item.price)}</td>
        ${isGstDocument ? `<td class="c-gst">${Number(item.taxRate || 0)}%</td>` : ''}
        <td class="c-amt">${currency(item.total)}</td>
      </tr>`
    )
    .join('');

  // HSN-wise tax breakup — required on a GST invoice and the same grouping GSTR-1 files.
  const taxSummaryHtml = isGstDocument
    ? `
    <div class="tax-summary">
      <div class="party-label">TAX SUMMARY${invoice.placeOfSupply?.state ? ` &middot; PLACE OF SUPPLY: ${escapeHtml(invoice.placeOfSupply.state)}` : ''}</div>
      <table class="tax-table">
        <thead>
          <tr>
            <th>${showHsnColumn ? 'HSN/SAC' : 'Rate'}</th>
            ${showHsnColumn ? '<th>Rate</th>' : ''}
            <th>Taxable</th>
            ${isInterState ? '<th>IGST</th>' : '<th>CGST</th><th>SGST</th>'}
            <th>Total tax</th>
          </tr>
        </thead>
        <tbody>
          ${taxSummary
            .map(
              (row) => `
            <tr>
              <td>${showHsnColumn ? escapeHtml(row.hsn || '-') : `${Number(row.rate || 0)}%`}</td>
              ${showHsnColumn ? `<td>${Number(row.rate || 0)}%</td>` : ''}
              <td>${currency(row.taxableValue)}</td>
              ${isInterState ? `<td>${currency(row.igst)}</td>` : `<td>${currency(row.cgst)}</td><td>${currency(row.sgst)}</td>`}
              <td>${currency(row.taxAmount)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`
    : '';

  const totalRows = [`<div class="t-row"><span>Subtotal</span><span>${currency(invoice.subtotal)}</span></div>`];
  if (discountAmount > 0) totalRows.push(`<div class="t-row"><span>Discount</span><span>-${currency(discountAmount)}</span></div>`);
  if (isGstDocument) {
    // A GST invoice must show the tax heads separately, never one merged "Tax" line.
    if (isInterState) {
      if (igstTotal > 0) totalRows.push(`<div class="t-row"><span>IGST</span><span>${currency(igstTotal)}</span></div>`);
    } else {
      if (cgstTotal > 0) totalRows.push(`<div class="t-row"><span>CGST</span><span>${currency(cgstTotal)}</span></div>`);
      if (sgstTotal > 0) totalRows.push(`<div class="t-row"><span>SGST</span><span>${currency(sgstTotal)}</span></div>`);
    }
  } else if (taxAmount > 0 || taxRate > 0) {
    totalRows.push(`<div class="t-row"><span>Tax (${taxRate}%)</span><span>${currency(taxAmount)}</span></div>`);
  }
  totalRows.push(`<div class="t-row t-total"><span>Total</span><span>${currency(invoice.total)}</span></div>`);
  if (showPaymentRows) totalRows.push(`<div class="t-row"><span>Paid</span><span>${currency(paidAmount)}</span></div>`);
  if (showPaymentRows && creditApplied > 0) {
    totalRows.push(`<div class="t-row"><span>Credit applied</span><span>${currency(creditApplied)}</span></div>`);
  }

  const balanceHtml = showPaymentRows
    ? `<div class="t-balance"><span>Balance due</span><span>${currency(balanceDue)}</span></div>`
    : '';

  // Per-invoice notes win; else the business's saved default; else the built-in copy.
  const notes = (invoice.notes && invoice.notes.trim()) || tpl.notes || DEFAULT_INVOICE_NOTES;
  // With the signature block on, leave room for a handwritten signatory line.
  // With it off, state that the invoice is system-generated so the empty space
  // reads as intentional and professional instead of a missing signature.
  const signImg = tpl.showSignature && isLogoData(tpl.signatureUrl)
    ? `<img class="sign-img" src="${tpl.signatureUrl}" alt="signature" />`
    : '<div class="sign-line"></div>';
  const signBlock = tpl.showSignature
    ? `<div class="sign">${signImg}<div class="sign-text">Authorized signatory</div></div>`
    : `<div class="sign sign-auto"><div class="sign-note">This is an electronically generated ${escapeHtml(doc.noun)};<br/>no signature is required.</div></div>`;
  const disclaimerHtml = doc.disclaimer
    ? `<div class="disclaimer"><span class="disclaimer-tag">NOT A TAX INVOICE</span>${escapeHtml(doc.disclaimer)}</div>`
    : '';
  const watermarkHtml = doc.watermark ? `<div class="watermark">${escapeHtml(doc.watermark)}</div>` : '';
  const footerInner = `
    ${tpl.showNotes ? `<div class="notes"><div class="party-label">NOTES &amp; TERMS</div><div class="notes-text">${escapeHtml(notes)}</div></div>` : '<div class="notes"></div>'}
    ${signBlock}
  `;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=794, initial-scale=1, maximum-scale=1" />
<style>
  :root { --accent: ${accent}; --accent-tint: ${tint(accent, 0.9)}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #ffffff; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #0f172a; -webkit-font-smoothing: antialiased; font-size: 13px; line-height: 1.45;
  }
  /* Always a full A4 sheet so the on-screen preview maps 1:1 into the A4-ratio
     preview frame — the footer, signature and notes sit in the same place the
     PDF puts them instead of falling outside a content-height page. */
  .page {
    background: #fff; width: 794px; min-height: 1123px;
    margin: 0 auto; padding: 48px 46px 36px;
    display: flex; flex-direction: column;
    position: relative; overflow: hidden;
  }
  /* Diagonal stamp behind the content. Kept light enough to print over and read
     through — it marks the sheet, it must not fight the numbers on it. */
  .watermark {
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%) rotate(-32deg);
    font-size: 108px; font-weight: 800; letter-spacing: 8px; white-space: nowrap;
    color: var(--accent); opacity: 0.08; pointer-events: none; z-index: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page > *:not(.watermark) { position: relative; z-index: 1; }
  .disclaimer {
    margin-top: 18px; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--accent); background: var(--accent-tint);
    font-size: 11px; line-height: 1.5; color: #334155;
  }
  .disclaimer-tag { display: block; font-size: 9.5px; font-weight: 800; letter-spacing: .6px; color: var(--accent); margin-bottom: 3px; }
  .rule { height: 1px; background: #e2e8f0; margin: 14px 0; }

  .header { display: flex; justify-content: space-between; align-items: flex-start; }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .logo { width: 52px; height: 52px; object-fit: contain; border: 1px solid #e2e8f0; border-radius: 10px; padding: 4px; }
  .title { font-size: 34px; font-weight: 800; letter-spacing: .5px; color: var(--accent); }
  .number { font-size: 14px; font-weight: 700; text-align: right; padding-top: 8px; }

  .meta { display: flex; gap: 18px; }
  .meta-cell { flex: 1; }
  .meta-label { font-size: 9px; font-weight: 700; letter-spacing: .5px; color: #94a3b8; }
  .meta-value { font-size: 13px; font-weight: 600; margin-top: 3px; }
  .meta-cell.accent .meta-value { color: var(--accent); }

  .parties { display: flex; gap: 28px; margin-bottom: 6px; }
  .party { flex: 1; }
  .party-label { font-size: 9px; font-weight: 700; letter-spacing: .6px; color: #94a3b8; margin-bottom: 4px; }
  .party-name { font-size: 15px; font-weight: 700; }
  .party-text { font-size: 11.5px; color: #64748b; margin-top: 2px; }

  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  thead th {
    background: var(--accent-tint); color: var(--accent);
    font-size: 10px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase;
    padding: 9px 10px; text-align: right;
  }
  thead th:first-child { text-align: left; border-radius: 6px 0 0 6px; }
  thead th:last-child { border-radius: 0 6px 6px 0; }
  tbody td { padding: 11px 10px; border-bottom: 1px solid #eef1f5; vertical-align: top; }
  .c-desc { text-align: left; width: 52%; }
  .c-hsn { text-align: right; color: #64748b; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .c-gst { text-align: right; color: #64748b; white-space: nowrap; }
  .c-qty { text-align: right; color: #64748b; white-space: nowrap; }
  .c-rate { text-align: right; color: #64748b; white-space: nowrap; }
  .c-amt { text-align: right; font-weight: 700; white-space: nowrap; }
  .item-name { font-size: 13px; font-weight: 600; }
  .item-sku { font-size: 10px; color: #94a3b8; margin-top: 2px; }

  .totals { display: flex; justify-content: flex-end; margin-top: 18px; }
  .totals-box { width: 280px; }
  .t-row { display: flex; justify-content: space-between; font-size: 12.5px; color: #64748b; padding: 4px 0; }
  .t-row span:last-child { color: #0f172a; font-weight: 600; }
  .t-total span { font-weight: 800 !important; }
  .t-total span:last-child { color: var(--accent) !important; }
  .t-balance { display: flex; justify-content: space-between; align-items: baseline; margin-top: 8px; padding-top: 8px; border-top: 1px solid #e2e8f0; }
  .t-balance span:first-child { font-size: 13px; font-weight: 800; color: var(--accent); }
  .t-balance span:last-child { font-size: 20px; font-weight: 800; color: var(--accent); }

  .tax-summary { margin-top: 20px; }
  .tax-table { margin-top: 6px; }
  .tax-table thead th { background: #f8fafc; color: #64748b; font-size: 9px; padding: 6px 8px; border-radius: 0; }
  .tax-table thead th:first-child { text-align: left; }
  .tax-table tbody td { padding: 6px 8px; font-size: 11px; text-align: right; border-bottom: 1px solid #f1f5f9; font-variant-numeric: tabular-nums; }
  .tax-table tbody td:first-child { text-align: left; }

  .footer-block { display: flex; justify-content: space-between; align-items: flex-end; gap: 28px; margin-top: 26px; }
  .notes { flex: 1; max-width: 420px; }
  .notes-text { font-size: 12px; color: #64748b; margin-top: 6px; line-height: 1.5; }
  .sign { width: 170px; text-align: center; }
  .sign-line { border-top: 1px solid #cbd5e1; margin-bottom: 5px; }
  .sign-img { max-height: 56px; max-width: 100%; object-fit: contain; margin-bottom: 2px; border-bottom: 1px solid #cbd5e1; }
  .sign-text { font-size: 10px; color: #94a3b8; }
  .sign-auto { width: 210px; text-align: right; }
  .sign-note { font-size: 10px; font-style: italic; color: #94a3b8; line-height: 1.5; }

  .spacer { flex: 1; }
  .brand-footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #e2e8f0; padding-top: 10px; margin-top: 28px; }
  .brand-side { flex: 1; font-size: 9.5px; color: #94a3b8; }
  .brand-side.right { text-align: right; }
  .brand-name { flex: 1; text-align: center; font-size: 10px; font-weight: 700; color: #0f172a; }
  .brand-bill { color: #0A2540; font-weight: 800; }
  .brand-ji { color: #1E7FFF; font-weight: 800; }
</style>
</head>
<body>
  <div class="page">
    ${watermarkHtml}
    <div class="header">
      <div class="header-left">
        ${logoHtml}
        <div class="title">${escapeHtml(doc.title)}</div>
      </div>
      <div class="number">${escapeHtml(invoice.invoiceNumber || invoice.documentNumber || '-')}</div>
    </div>
    <div class="rule"></div>

    <div class="meta">
      ${metaCells
        .map(
          ([label, value], i) =>
            `<div class="meta-cell${showPaymentRows && i === metaCells.length - 1 ? ' accent' : ''}"><div class="meta-label">${escapeHtml(label.toUpperCase())}</div><div class="meta-value">${escapeHtml(value)}</div></div>`
        )
        .join('')}
    </div>
    <div class="rule"></div>

    <div class="parties">
      ${partyBlock('FROM', business.businessName || 'Your Business', fromLines)}
      ${partyBlock('BILL TO', customer.name || 'Customer', toLines)}
    </div>

    <table>
      <thead>
        <tr><th>Description</th>${showHsnColumn ? '<th>HSN/SAC</th>' : ''}<th>Qty</th><th>Rate</th>${isGstDocument ? '<th>GST</th>' : ''}<th>Amount</th></tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    <div class="totals"><div class="totals-box">${totalRows.join('')}${balanceHtml}</div></div>

    ${taxSummaryHtml}

    ${disclaimerHtml}

    <div class="footer-block">${footerInner}</div>

    <div class="spacer"></div>
    <div class="brand-footer">
      <div class="brand-side">Page 1</div>
      <div class="brand-name">Powered by <span class="brand-bill">Bill</span><span class="brand-ji">Ji</span></div>
      <div class="brand-side right">Electronically generated</div>
    </div>
  </div>
</body>
</html>`;
};

export { resolveTemplate };
