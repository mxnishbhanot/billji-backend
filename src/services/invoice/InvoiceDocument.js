import React from 'react';
import { Document, Image, Page, Text, View } from '@react-pdf/renderer';
import { deriveDocumentView } from './invoiceHelpers.js';
import { columnWidths, createStyles } from './invoiceStyles.js';

// The backend has no JSX toolchain (plain ESM, `node src/server.js`), so the element
// tree is written with createElement directly rather than pulling in a build step for
// one file.
const h = React.createElement;

// Layout only. Every value on the page arrives pre-derived from deriveDocumentView,
// which in turn only formats what utils/invoiceMath.js already calculated.

const Rule = (styles) => h(View, { style: styles.rule });

const Party = (styles, label, name, lines) =>
  h(
    View,
    { style: styles.party },
    h(Text, { style: styles.partyLabel }, label),
    h(Text, { style: styles.partyName }, name),
    lines.map((line, i) => h(Text, { key: i, style: styles.partyText }, line))
  );

const ItemsTable = (styles, view) => {
  const widths = columnWidths(view);
  const order = ['desc', ...(view.showHsnColumn ? ['hsn'] : []), 'qty', 'rate', ...(view.isGstDocument ? ['gst'] : []), 'amount'];
  const last = order.length - 1;

  return h(
    View,
    { style: styles.table },
    // `fixed` repeats the header on every page the table spills onto.
    h(
      View,
      { style: styles.tableHeadRow, fixed: true },
      view.itemHeaders.map((label, i) =>
        h(
          Text,
          {
            key: label,
            style: [
              styles.tableHeadCell,
              { width: widths[order[i]] },
              i === 0 ? styles.tableHeadFirst : null,
              i === last ? styles.tableHeadLast : null
            ]
          },
          label
        )
      )
    ),
    view.items.map((item, rowIndex) =>
      // A row is short enough that splitting it across a page break only ever looks
      // like a mistake.
      h(
        View,
        { key: rowIndex, style: styles.tableRow, wrap: false },
        h(
          View,
          { style: [styles.tableCell, { width: widths.desc, textAlign: 'left' }] },
          h(Text, { style: styles.itemName }, item.name),
          item.sku ? h(Text, { style: styles.itemSku }, `SKU: ${item.sku}`) : null
        ),
        item.hsn === null ? null : h(Text, { style: [styles.tableCell, { width: widths.hsn }] }, item.hsn),
        h(Text, { style: [styles.tableCell, { width: widths.qty }] }, item.quantity),
        h(Text, { style: [styles.tableCell, { width: widths.rate }] }, item.rate),
        item.gst === null ? null : h(Text, { style: [styles.tableCell, { width: widths.gst }] }, item.gst),
        h(Text, { style: [styles.tableCell, styles.amountCell, { width: widths.amount }] }, item.amount)
      )
    )
  );
};

const TaxSummary = (styles, view) => {
  if (!view.isGstDocument) return null;

  // The first column carries HSN codes or a rate; the rest are money and share the
  // remaining width evenly.
  const rest = `${78 / Math.max(view.taxSummaryHeaders.length - 1, 1)}%`;
  const widthFor = (i) => (i === 0 ? '22%' : rest);

  return h(
    View,
    { style: styles.taxSummary },
    h(
      Text,
      { style: styles.partyLabel },
      view.placeOfSupplyState ? `TAX SUMMARY · PLACE OF SUPPLY: ${view.placeOfSupplyState}` : 'TAX SUMMARY'
    ),
    h(
      View,
      { style: styles.taxTable },
      h(
        View,
        { style: styles.taxHeadRow },
        view.taxSummaryHeaders.map((label, i) =>
          h(Text, { key: label + i, style: [styles.taxHeadCell, { width: widthFor(i) }, i === 0 ? styles.firstColumnLeft : null] }, label)
        )
      ),
      view.taxSummaryRows.map((row, rowIndex) =>
        h(
          View,
          { key: rowIndex, style: styles.taxRow, wrap: false },
          row.map((cell, i) =>
            h(Text, { key: i, style: [styles.taxCell, { width: widthFor(i) }, i === 0 ? styles.firstColumnLeft : null] }, cell)
          )
        )
      )
    )
  );
};

const Totals = (styles, view) =>
  h(
    View,
    { style: styles.totals },
    h(
      View,
      { style: styles.totalsBox },
      view.totalRows.map((row, i) =>
        h(
          View,
          { key: i, style: styles.totalRow },
          h(Text, { style: [styles.totalLabel, row.emphasis ? styles.grandLabel : null] }, row.label),
          h(Text, { style: [styles.totalValue, row.emphasis ? styles.grandValue : null] }, row.value)
        )
      ),
      view.balanceRow
        ? h(
            View,
            { style: styles.balanceRow },
            h(Text, { style: styles.balanceLabel }, view.balanceRow.label),
            h(Text, { style: styles.balanceValue }, view.balanceRow.value)
          )
        : null
    )
  );

const SignatureBlock = (styles, view) => {
  if (!view.showSignature) {
    return h(
      View,
      { style: styles.signAuto },
      // Two Text nodes rather than one with a newline: React PDF turns the line break
      // into an empty run that resolves to its own default font, which drags a
      // base-14 Helvetica into the file.
      h(Text, { style: styles.signNote }, `This is an electronically generated ${view.doc.noun};`),
      h(Text, { style: styles.signNote }, 'no signature is required.')
    );
  }

  return h(
    View,
    { style: styles.sign },
    view.signatureUrl ? h(Image, { style: styles.signImage, src: view.signatureUrl }) : h(View, { style: styles.signLine }),
    h(Text, { style: styles.signText }, 'Authorized signatory')
  );
};

export const InvoiceDocument = ({ invoice, business, options }) => {
  const view = deriveDocumentView(invoice, business, options);
  const styles = createStyles(view.accent, view.accentTint);

  return h(
    Document,
    { title: view.documentNumber, author: view.businessName },
    h(
      Page,
      { size: 'A4', style: styles.page },

      // Drawn first so the content paints over it — React PDF has no z-index.
      view.doc.watermark ? h(Text, { style: styles.watermark, fixed: true }, view.doc.watermark) : null,

      h(
        View,
        { style: styles.header },
        h(
          View,
          { style: styles.headerLeft },
          view.logoUrl ? h(Image, { style: styles.logo, src: view.logoUrl }) : null,
          h(Text, { style: styles.title }, view.doc.title)
        ),
        h(Text, { style: styles.number }, view.documentNumber)
      ),
      Rule(styles),

      h(
        View,
        { style: styles.meta },
        view.metaCells.map(([label, value], i) =>
          h(
            View,
            { key: label, style: styles.metaCell },
            h(Text, { style: styles.metaLabel }, label.toUpperCase()),
            h(
              Text,
              { style: [styles.metaValue, view.showPaymentRows && i === view.metaCells.length - 1 ? styles.metaValueAccent : null] },
              value
            )
          )
        )
      ),
      Rule(styles),

      h(
        View,
        { style: styles.parties },
        Party(styles, 'FROM', view.businessName, view.fromLines),
        Party(styles, 'BILL TO', view.customerName, view.toLines)
      ),

      ItemsTable(styles, view),
      Totals(styles, view),
      TaxSummary(styles, view),

      view.doc.disclaimer
        ? h(
            View,
            { style: styles.disclaimer, wrap: false },
            h(Text, { style: styles.disclaimerTag }, 'NOT A TAX INVOICE'),
            h(Text, { style: styles.disclaimerText }, view.doc.disclaimer)
          )
        : null,

      h(
        View,
        { style: styles.footerBlock, wrap: false },
        h(
          View,
          { style: styles.notes },
          view.showNotes ? h(Text, { style: styles.partyLabel }, 'NOTES & TERMS') : null,
          view.showNotes ? h(Text, { style: styles.notesText }, view.notes) : null
        ),
        SignatureBlock(styles, view)
      ),

      h(
        View,
        { style: styles.brandFooter, fixed: true },
        h(Text, {
          style: styles.brandSide,
          // The HTML template printed a hardcoded "Page 1" on every sheet.
          render: ({ pageNumber, totalPages }) => (totalPages > 1 ? `Page ${pageNumber} of ${totalPages}` : 'Page 1')
        }),
        h(
          Text,
          { style: styles.brandName },
          'Powered by ',
          h(Text, { style: styles.brandBill }, 'Bill'),
          h(Text, { style: styles.brandJi }, 'Ji')
        ),
        h(Text, { style: [styles.brandSide, styles.brandSideRight] }, 'Electronically generated')
      )
    )
  );
};
