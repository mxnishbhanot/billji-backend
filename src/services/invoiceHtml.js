// HTML rendering of an invoice, used by the live mobile preview: the app fetches it
// from the preview endpoints and shows it in a WebView. The PDF is rendered separately
// by services/invoice (React PDF). Both consume the same derived view from
// services/invoice/invoiceHelpers.js, so what a document says can never differ between
// the two — only how it is drawn.

import { deriveDocumentView } from './invoice/invoiceHelpers.js';

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const partyBlock = (label, lead, lines) => `
  <div class="party">
    <div class="party-label">${escapeHtml(label)}</div>
    <div class="party-name">${escapeHtml(lead)}</div>
    ${lines.map((line) => `<div class="party-text">${escapeHtml(line)}</div>`).join('')}
  </div>`;

export const buildInvoiceHtml = (invoice = {}, businessContext = {}, options = {}) => {
  const view = deriveDocumentView(invoice, businessContext, options);
  const accent = view.accent;

  const logoHtml = view.logoUrl ? `<img class="logo" src="${view.logoUrl}" alt="logo" />` : '';

  const itemsHtml = view.items
    .map(
      (item) => `
      <tr>
        <td class="c-desc">
          <div class="item-name">${escapeHtml(item.name)}</div>
          ${item.sku ? `<div class="item-sku">SKU: ${escapeHtml(item.sku)}</div>` : ''}
        </td>
        ${item.hsn === null ? '' : `<td class="c-hsn">${escapeHtml(item.hsn)}</td>`}
        <td class="c-qty">${escapeHtml(item.quantity)}</td>
        <td class="c-rate">${escapeHtml(item.rate)}</td>
        ${item.gst === null ? '' : `<td class="c-gst">${escapeHtml(item.gst)}</td>`}
        <td class="c-amt">${escapeHtml(item.amount)}</td>
      </tr>`
    )
    .join('');

  const taxSummaryHtml = view.isGstDocument
    ? `
    <div class="tax-summary">
      <div class="party-label">TAX SUMMARY${view.placeOfSupplyState ? ` &middot; PLACE OF SUPPLY: ${escapeHtml(view.placeOfSupplyState)}` : ''}</div>
      <table class="tax-table">
        <thead>
          <tr>${view.taxSummaryHeaders.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${view.taxSummaryRows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`
    : '';

  const totalRows = view.totalRows
    .map(
      (row) =>
        `<div class="t-row${row.emphasis ? ' t-total' : ''}"><span>${escapeHtml(row.label)}</span><span>${escapeHtml(row.value)}</span></div>`
    )
    .join('');

  const balanceHtml = view.balanceRow
    ? `<div class="t-balance"><span>${escapeHtml(view.balanceRow.label)}</span><span>${escapeHtml(view.balanceRow.value)}</span></div>`
    : '';

  const signImg = view.signatureUrl
    ? `<img class="sign-img" src="${view.signatureUrl}" alt="signature" />`
    : '<div class="sign-line"></div>';
  const signBlock = view.showSignature
    ? `<div class="sign">${signImg}<div class="sign-text">Authorized signatory</div></div>`
    : `<div class="sign sign-auto"><div class="sign-note">This is an electronically generated ${escapeHtml(view.doc.noun)};<br/>no signature is required.</div></div>`;
  const disclaimerHtml = view.doc.disclaimer
    ? `<div class="disclaimer"><span class="disclaimer-tag">NOT A TAX INVOICE</span>${escapeHtml(view.doc.disclaimer)}</div>`
    : '';
  const watermarkHtml = view.doc.watermark ? `<div class="watermark">${escapeHtml(view.doc.watermark)}</div>` : '';
  const footerInner = `
    ${view.showNotes ? `<div class="notes"><div class="party-label">NOTES &amp; TERMS</div><div class="notes-text">${escapeHtml(view.notes)}</div></div>` : '<div class="notes"></div>'}
    ${signBlock}
  `;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=794, initial-scale=1, maximum-scale=1" />
<style>
  :root { --accent: ${accent}; --accent-tint: ${view.accentTint}; }
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
        <div class="title">${escapeHtml(view.doc.title)}</div>
      </div>
      <div class="number">${escapeHtml(view.documentNumber)}</div>
    </div>
    <div class="rule"></div>

    <div class="meta">
      ${view.metaCells
        .map(
          ([label, value], i) =>
            `<div class="meta-cell${view.showPaymentRows && i === view.metaCells.length - 1 ? ' accent' : ''}"><div class="meta-label">${escapeHtml(label.toUpperCase())}</div><div class="meta-value">${escapeHtml(value)}</div></div>`
        )
        .join('')}
    </div>
    <div class="rule"></div>

    <div class="parties">
      ${partyBlock('FROM', view.businessName, view.fromLines)}
      ${partyBlock('BILL TO', view.customerName, view.toLines)}
    </div>

    <table>
      <thead>
        <tr>${view.itemHeaders.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>

    <div class="totals"><div class="totals-box">${totalRows}${balanceHtml}</div></div>

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
