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

const resolveTemplate = (business = {}) => {
  const tpl = business.invoiceTemplate || {};
  return {
    accentColor: /^#[0-9a-fA-F]{6}$/.test(tpl.accentColor || '') ? tpl.accentColor : '#4338CA',
    showLogo: tpl.showLogo !== false,
    showNotes: tpl.showNotes !== false,
    showSignature: tpl.showSignature !== false,
    showPaymentRows: tpl.showPaymentRows !== false
  };
};

const isLogoData = (logoUrl = '') => /^data:image\/(?:png|jpe?g);base64,/i.test(logoUrl);

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

  const paidAmount = Number(invoice.paidAmount ?? (invoice.paymentStatus === 'paid' ? invoice.total : 0));
  const balanceDue = Number(invoice.balanceDue ?? Math.max(Number(invoice.total || 0) - paidAmount, 0));
  const discountAmount = Number(invoice.discount?.amount || 0);
  const taxAmount = Number(invoice.tax?.amount || 0);
  const taxRate = Number(invoice.tax?.rate || 0);

  const logoHtml = tpl.showLogo && isLogoData(business.logoUrl)
    ? `<img class="logo" src="${business.logoUrl}" alt="logo" />`
    : '';

  const metaCells = [
    ['Issue date', formatDate(invoice.date) || '-'],
    ['Due date', formatDate(invoice.dueDate) || 'On receipt'],
    ['Payment', statusText(invoice.paymentStatus || invoice.status || 'unpaid')]
  ];
  if (tpl.showPaymentRows) metaCells.push(['Balance', currency(balanceDue)]);

  const fromLines = [
    joinLines([business.phone, business.email]).join('  |  '),
    ...businessAddress(business),
    business.gstNumber ? `GSTIN: ${business.gstNumber}` : '',
    business.panNumber ? `PAN: ${business.panNumber}` : ''
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
        <td class="c-qty">${escapeHtml(item.quantity)}</td>
        <td class="c-rate">${currency(item.price)}</td>
        <td class="c-amt">${currency(item.total)}</td>
      </tr>`
    )
    .join('');

  const totalRows = [`<div class="t-row"><span>Subtotal</span><span>${currency(invoice.subtotal)}</span></div>`];
  if (discountAmount > 0) totalRows.push(`<div class="t-row"><span>Discount</span><span>-${currency(discountAmount)}</span></div>`);
  if (taxAmount > 0 || taxRate > 0) totalRows.push(`<div class="t-row"><span>Tax (${taxRate}%)</span><span>${currency(taxAmount)}</span></div>`);
  totalRows.push(`<div class="t-row t-total"><span>Total</span><span>${currency(invoice.total)}</span></div>`);
  if (tpl.showPaymentRows) totalRows.push(`<div class="t-row"><span>Paid</span><span>${currency(paidAmount)}</span></div>`);

  const balanceHtml = tpl.showPaymentRows
    ? `<div class="t-balance"><span>Balance due</span><span>${currency(balanceDue)}</span></div>`
    : '';

  const notes = invoice.notes || 'Please make payment by the due date. Quote the invoice number when paying.';
  const footerInner = `
    ${tpl.showNotes ? `<div class="notes"><div class="party-label">NOTES &amp; TERMS</div><div class="notes-text">${escapeHtml(notes)}</div></div>` : '<div class="notes"></div>'}
    ${tpl.showSignature ? '<div class="sign"><div class="sign-line"></div><div class="sign-text">Authorized signatory</div></div>' : ''}
  `;

  // `screen` mode (mobile preview, fits a WebView at 794 CSS px wide) lets the page
  // grow to content height; `print` mode (PDF) fills a full A4 sheet. Typography and
  // layout are identical so the two render the same.
  const screen = options.mode === 'screen';

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
  .page {
    background: #fff; width: 794px; min-height: ${screen ? 'auto' : '1123px'};
    margin: 0 auto; padding: 48px 46px 36px;
    display: flex; flex-direction: column;
  }
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

  .footer-block { display: flex; justify-content: space-between; align-items: flex-end; gap: 28px; margin-top: 26px; }
  .notes { flex: 1; max-width: 420px; }
  .notes-text { font-size: 12px; color: #64748b; margin-top: 6px; line-height: 1.5; }
  .sign { width: 170px; text-align: center; }
  .sign-line { border-top: 1px solid #cbd5e1; margin-bottom: 5px; }
  .sign-text { font-size: 10px; color: #94a3b8; }

  .spacer { flex: 1; }
  .brand-footer { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #e2e8f0; padding-top: 10px; margin-top: 28px; }
  .brand-side { flex: 1; font-size: 9.5px; color: #94a3b8; }
  .brand-side.right { text-align: right; }
  .brand-name { flex: 1; text-align: center; font-size: 10px; font-weight: 700; color: #0f172a; }
</style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="header-left">
        ${logoHtml}
        <div class="title">INVOICE</div>
      </div>
      <div class="number">${escapeHtml(invoice.invoiceNumber || '-')}</div>
    </div>
    <div class="rule"></div>

    <div class="meta">
      ${metaCells
        .map(
          ([label, value], i) =>
            `<div class="meta-cell${tpl.showPaymentRows && i === metaCells.length - 1 ? ' accent' : ''}"><div class="meta-label">${escapeHtml(label.toUpperCase())}</div><div class="meta-value">${escapeHtml(value)}</div></div>`
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
        <tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    <div class="totals"><div class="totals-box">${totalRows.join('')}${balanceHtml}</div></div>

    ${tpl.showNotes || tpl.showSignature ? `<div class="footer-block">${footerInner}</div>` : ''}

    <div class="spacer"></div>
    <div class="brand-footer">
      <div class="brand-side">Page 1</div>
      <div class="brand-name">Powered by BillJi</div>
      <div class="brand-side right">Electronically generated</div>
    </div>
  </div>
</body>
</html>`;
};

export { resolveTemplate };
