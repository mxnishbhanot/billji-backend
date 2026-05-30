import PDFDocument from 'pdfkit';

const currency = (value) => `Rs. ${Number(value || 0).toFixed(2)}`;
const PAGE = { left: 46, right: 550, width: 504, bottom: 728, footer: 762 };
const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  subtle: '#94a3b8',
  light: '#f8fafc',
  line: '#e2e8f0',
  corner: '#cbd5e1'
};

const logoBufferFromDataUrl = (logoUrl = '') => {
  const match = /^data:image\/(?:png|jpe?g);base64,(.+)$/i.exec(logoUrl);

  if (!match) {
    return null;
  }

  try {
    return Buffer.from(match[1], 'base64');
  } catch {
    return null;
  }
};

const drawImage = (doc, image, x, y, options) => {
  try {
    doc.image(image, x, y, options);
    return true;
  } catch {
    return false;
  }
};

const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const joinLines = (lines = []) => lines.filter(Boolean).map((line) => String(line).trim()).filter(Boolean);

const businessAddress = (business = {}) =>
  joinLines([
    business.address,
    joinLines([business.city, business.state, business.pinCode]).join(', '),
    business.website
  ]);

const customerAddress = (customer = {}) => {
  const billing = customer.billingAddress || {};
  const structured = joinLines([
    billing.line1,
    billing.line2,
    joinLines([billing.city, billing.state, billing.pinCode]).join(', ')
  ]);

  return structured.length ? structured : joinLines([customer.address]);
};

const customerTaxLabel = (customer = {}) => {
  if (customer.gstNumber || customer.taxIdentifiers?.gstNumber) return `GSTIN: ${customer.gstNumber || customer.taxIdentifiers.gstNumber}`;
  if (customer.taxIdentifiers?.panNumber) return `PAN: ${customer.taxIdentifiers.panNumber}`;
  return '';
};

const paymentStatusLabel = (invoice = {}) => String(invoice.paymentStatus || invoice.status || 'unpaid').replace(/_/g, ' ').toUpperCase();

const statusTone = (status = '') => {
  if (status === 'paid') return { stroke: '#16a34a', text: '#15803d' };
  if (status === 'partial') return { stroke: '#22c55e', text: '#15803d' };
  if (status === 'cancelled' || status === 'void') return { stroke: COLORS.subtle, text: COLORS.muted };
  return { stroke: COLORS.subtle, text: COLORS.muted };
};

const drawFooter = (doc, pageNumber) => {
  const y = PAGE.footer;

  doc.save();
  doc.moveTo(PAGE.left, y - 16).lineTo(PAGE.right, y - 16).stroke(COLORS.line);
  doc.fillColor(COLORS.subtle).fontSize(8).font('Helvetica').text(`Page ${pageNumber}`, PAGE.left, y - 2, { width: 80 });
  doc.fillColor(COLORS.subtle).fontSize(8).font('Helvetica').text('Powered by BillJi', PAGE.left + 180, y - 2, { width: 140, align: 'center' });
  doc.fillColor(COLORS.subtle).fontSize(8).font('Helvetica').text('Thank you for your business', PAGE.right - 130, y - 2, { width: 130, align: 'right' });
  doc.restore();
};

const drawBusinessLogo = (doc, logoUrl, x, y, size) => {
  const logo = logoBufferFromDataUrl(logoUrl);

  if (!logo) {
    return false;
  }

  const drawn = drawImage(doc, logo, x + 4, y + 4, { fit: [size - 8, size - 8] });
  doc.roundedRect(x, y, size, size, 8).stroke(COLORS.line);
  return drawn;
};

const drawBadge = (doc, label, x, y, tone) => {
  const width = Math.max(doc.font('Helvetica-Bold').fontSize(8).widthOfString(label) + 22, 76);
  doc.roundedRect(x - width, y, width, 20, 10).fillAndStroke(tone.fill, tone.stroke);
  doc.fillColor(tone.text).fontSize(8).font('Helvetica-Bold').text(label, x - width, y + 6, { width, align: 'center' });
};

const stampLabel = (invoice = {}) => {
  const status = invoice.paymentStatus || invoice.status || 'unpaid';
  if (status === 'partial') return 'PARTIALLY PAID';
  if (status === 'paid') return 'PAID';
  return paymentStatusLabel(invoice);
};

const drawStatusStamp = (doc, invoice, x, y) => {
  const label = stampLabel(invoice);
  const tone = statusTone(invoice.paymentStatus || invoice.status);
  const width = Math.max(doc.font('Helvetica-Bold').fontSize(11).widthOfString(label) + 28, 96);
  const height = 28;

  doc.save();
  doc.rotate(-6, { origin: [x - width / 2, y + height / 2] });
  doc.opacity(0.72);
  doc.roundedRect(x - width, y, width, height, 4).dash(3, { space: 3 }).strokeColor(tone.stroke).lineWidth(1.4).stroke();
  doc.undash();
  doc.fillColor(tone.text).font('Helvetica-Bold').fontSize(11).text(label, x - width, y + 9, { width, align: 'center', characterSpacing: 0.6 });
  doc.restore();
};

const drawCard = (doc, x, y, width, height, { fill = '#ffffff', stroke = COLORS.line } = {}) => {
  doc.roundedRect(x, y, width, height, 16).fillAndStroke(fill, stroke);
};

const drawLabelValue = (doc, label, value, x, y, width, options = {}) => {
  doc.fillColor(options.labelColor || COLORS.muted).fontSize(8).font('Helvetica-Bold').text(label.toUpperCase(), x, y, { width, characterSpacing: 0.3 });
  doc.fillColor(options.valueColor || COLORS.ink).fontSize(options.valueSize || 11).font(options.bold ? 'Helvetica-Bold' : 'Helvetica').text(value || '-', x, y + 14, { width });
};

const drawInfoCard = (doc, title, lines, x, y, width, height) => {
  drawCard(doc, x, y, width, height, { fill: '#ffffff', stroke: COLORS.line });
  doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica-Bold').text(title.toUpperCase(), x + 16, y + 14, { characterSpacing: 0.5 });
  joinLines(lines).slice(0, 5).forEach((line, index) => {
    doc
      .fillColor(index === 0 ? COLORS.ink : COLORS.muted)
      .fontSize(index === 0 ? 11 : 9)
      .font(index === 0 ? 'Helvetica-Bold' : 'Helvetica')
      .text(line, x + 16, y + 34 + index * 14, { width: width - 32 });
  });
};

const drawTableHeader = (doc, y) => {
  doc.rect(PAGE.left, y, PAGE.width, 30).fill(COLORS.light);
  doc.moveTo(PAGE.left, y).lineTo(PAGE.right, y).stroke(COLORS.line);
  doc.moveTo(PAGE.left, y + 30).lineTo(PAGE.right, y + 30).stroke(COLORS.line);
  doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica-Bold');
  doc.text('ITEM', 62, y + 13, { width: 205 });
  doc.text('QTY', 282, y + 13, { width: 40, align: 'right' });
  doc.text('RATE', 334, y + 13, { width: 66, align: 'right' });
  doc.text('TAX', 410, y + 13, { width: 50, align: 'right' });
  doc.text('TOTAL', 472, y + 13, { width: 60, align: 'right' });
};

const drawTopHeader = (doc, invoice, business) => {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');

  const hasLogo = drawBusinessLogo(doc, business.logoUrl, PAGE.left, 48, 46);
  const businessX = hasLogo ? PAGE.left + 58 : PAGE.left;
  const businessWidth = hasLogo ? 250 : 315;
  const addressLines = businessAddress(business);

  doc.fillColor(COLORS.ink).fontSize(16).font('Helvetica-Bold').text(business.businessName || 'QuickInvoice Business', businessX, 48, {
    width: businessWidth,
    lineGap: 2
  });
  doc.fillColor(COLORS.muted).fontSize(8.5).font('Helvetica').text(addressLines.join(' | ') || 'Business address not set', businessX, 73, {
    width: businessWidth,
    lineGap: 2
  });
  doc.text(joinLines([business.phone, business.email]).join(' | '), businessX, 96, { width: businessWidth });
  if (business.gstNumber || business.panNumber) {
    doc.fillColor(COLORS.muted).fontSize(8).text(joinLines([business.gstNumber ? `GSTIN: ${business.gstNumber}` : '', business.panNumber ? `PAN: ${business.panNumber}` : '']).join(' | '), businessX, 111, { width: businessWidth });
  }

  doc.fillColor(COLORS.ink).fontSize(24).font('Helvetica-Bold').text('INVOICE', 360, 48, { width: 188, align: 'right' });
  doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica').text(invoice.invoiceNumber, 360, 82, { width: 188, align: 'right' });
  drawBadge(doc, paymentStatusLabel(invoice), PAGE.right, 106, statusTone(invoice.paymentStatus || invoice.status));
  doc.moveTo(PAGE.left, 146).lineTo(PAGE.right, 146).stroke(COLORS.line);
};

const drawSummaryStrip = (doc, invoice) => {
  const paidAmount = Number(invoice.paidAmount ?? (invoice.paymentStatus === 'paid' ? invoice.total : 0));
  const balanceDue = Number(invoice.balanceDue ?? Math.max(Number(invoice.total || 0) - paidAmount, 0));
  const cards = [
    { label: 'Invoice Date', value: formatDate(invoice.date) || '-' },
    { label: 'Due Date', value: formatDate(invoice.dueDate) || 'On receipt' },
    { label: 'Paid', value: currency(paidAmount) },
    { label: 'Balance Due', value: currency(balanceDue) }
  ];
  const gap = 10;
  const width = (PAGE.width - gap * 3) / 4;

  cards.forEach((card, index) => {
    const x = PAGE.left + index * (width + gap);
    drawCard(doc, x, 190, width, 62, { fill: '#ffffff', stroke: COLORS.line });
    drawLabelValue(doc, card.label, card.value, x + 14, 205, width - 28, { valueColor: COLORS.ink, bold: index === 3 });
  });
};

const drawTotals = (doc, invoice, x, y) => {
  const paidAmount = Number(invoice.paidAmount ?? (invoice.paymentStatus === 'paid' ? invoice.total : 0));
  const balanceDue = Number(invoice.balanceDue ?? Math.max(Number(invoice.total || 0) - paidAmount, 0));
  const rows = [
    ['Subtotal', currency(invoice.subtotal)],
    ['Discount', `-${currency(invoice.discount?.amount)}`],
    [`Tax (${invoice.tax?.rate ?? 0}%)`, currency(invoice.tax?.amount)],
    ['Paid', currency(paidAmount)]
  ];

  drawCard(doc, x, y, 214, 154, { fill: '#ffffff', stroke: COLORS.line });
  rows.forEach(([label, value], index) => {
    const rowY = y + 18 + index * 22;
    doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica').text(label, x + 18, rowY, { width: 90 });
    doc.fillColor(COLORS.ink).fontSize(9).font('Helvetica-Bold').text(value, x + 112, rowY, { width: 82, align: 'right' });
  });
  doc.moveTo(x + 18, y + 108).lineTo(x + 196, y + 108).stroke(COLORS.line);
  doc.fillColor(COLORS.ink).fontSize(10).font('Helvetica-Bold').text('Balance Due', x + 18, y + 122);
  doc.fillColor(COLORS.ink).fontSize(15).font('Helvetica-Bold').text(currency(balanceDue), x + 98, y + 119, {
    width: 96,
    align: 'right'
  });
};

const drawNotesAndTerms = (doc, invoice, business, x, y) => {
  drawCard(doc, x, y, 270, 154, { fill: '#ffffff', stroke: COLORS.line });
  doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica-Bold').text('NOTES & TERMS', x + 16, y + 16, { characterSpacing: 0.5 });
  const notes = invoice.notes || 'Please make payment by the due date. Quote the invoice number when paying.';
  doc.fillColor(COLORS.ink).fontSize(9).font('Helvetica').text(notes, x + 16, y + 36, { width: 238, lineGap: 3 });
  doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica').text(`Issued by ${business.businessName || 'QuickInvoice Business'}`, x + 16, y + 118, {
    width: 150
  });
  doc.moveTo(x + 176, y + 124).lineTo(x + 252, y + 124).stroke(COLORS.line);
  doc.fillColor(COLORS.muted).fontSize(7.5).font('Helvetica').text('Authorized signatory', x + 176, y + 130, { width: 80, align: 'center' });
};

const statusText = (value = '') => String(value || '').replace(/_/g, ' ').toUpperCase();

const drawCleanRule = (doc, y, color = COLORS.line) => {
  doc.save().strokeColor(color).lineWidth(1).moveTo(PAGE.left, y).lineTo(PAGE.right, y).stroke().restore();
};

const drawPageCorners = (doc) => {
  const inset = 24;
  const len = 30;
  const right = doc.page.width - inset;
  const bottom = doc.page.height - inset;

  doc.save().strokeColor(COLORS.corner).lineWidth(1.1);
  doc.moveTo(inset, inset + len).lineTo(inset, inset).lineTo(inset + len, inset).stroke();
  doc.moveTo(right - len, inset).lineTo(right, inset).lineTo(right, inset + len).stroke();
  doc.moveTo(inset, bottom - len).lineTo(inset, bottom).lineTo(inset + len, bottom).stroke();
  doc.moveTo(right - len, bottom).lineTo(right, bottom).lineTo(right, bottom - len).stroke();
  doc.restore();
};

const textBlock = (doc, lines, x, y, width, options = {}) => {
  let currentY = y;
  joinLines(lines).forEach((line, index) => {
    const isLead = index === 0 && options.lead !== false;
    const size = isLead ? (options.leadSize || 10) : (options.size || 8.7);
    const font = isLead ? 'Helvetica-Bold' : 'Helvetica';
    const color = isLead ? COLORS.ink : COLORS.muted;
    doc.fillColor(color).font(font).fontSize(size).text(line, x, currentY, { width, lineGap: 2 });
    currentY = doc.y + (options.gap ?? 4);
  });
  return currentY;
};

const drawCleanHeader = (doc, invoice, business) => {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');
  drawPageCorners(doc);

  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(26).text('INVOICE', PAGE.left, 48, { width: 220 });
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text('Electronically generated tax invoice', PAGE.left, 82, { width: 240 });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10).text(invoice.invoiceNumber || '-', 360, 52, { width: 190, align: 'right' });
  drawCleanRule(doc, 116);
};

const drawCleanMeta = (doc, invoice) => {
  const paidAmount = Number(invoice.paidAmount ?? (invoice.paymentStatus === 'paid' ? invoice.total : 0));
  const balanceDue = Number(invoice.balanceDue ?? Math.max(Number(invoice.total || 0) - paidAmount, 0));
  const meta = [
    ['Issue date', formatDate(invoice.date) || '-'],
    ['Due date', formatDate(invoice.dueDate) || 'On receipt'],
    ['Payment', statusText(invoice.paymentStatus || invoice.status || 'unpaid')],
    ['Document', statusText(invoice.documentStatus || 'issued')],
    ['Paid', currency(paidAmount)],
    ['Balance due', currency(balanceDue)]
  ];
  const widths = [76, 76, 82, 82, 74, 90];
  let x = PAGE.left;

  meta.forEach(([label, value], index) => {
    const width = widths[index];
    doc.fillColor(COLORS.subtle).font('Helvetica-Bold').fontSize(7.2).text(label.toUpperCase(), x, 136, { width, characterSpacing: 0.35 });
    doc.fillColor(COLORS.ink).font(index === meta.length - 1 ? 'Helvetica-Bold' : 'Helvetica').fontSize(index === meta.length - 1 ? 10 : 8.8).text(value, x, 151, {
      width,
      lineGap: 1
    });
    x += width + 14;
  });

  drawCleanRule(doc, 186);
};

const partyLines = (title, entity = {}, extra = []) => [
  title,
  entity.name || '',
  entity.phone || '',
  entity.email || '',
  ...customerAddress(entity),
  customerTaxLabel(entity),
  ...extra
];

const drawCleanParties = (doc, invoice, business) => {
  const y = 210;
  const colWidth = 226;
  const fromLines = [
    'From',
    business.businessName || 'QuickInvoice Business',
    ...businessAddress(business),
    joinLines([business.phone, business.email]).join(' | '),
    business.gstNumber ? `GSTIN: ${business.gstNumber}` : '',
    business.panNumber ? `PAN: ${business.panNumber}` : ''
  ];
  const toLines = partyLines('Bill To', invoice.customerSnapshot || {});

  doc.fillColor(COLORS.subtle).font('Helvetica-Bold').fontSize(7.5).text(fromLines[0].toUpperCase(), PAGE.left, y, { characterSpacing: 0.5 });
  const fromEnd = textBlock(doc, fromLines.slice(1), PAGE.left, y + 18, colWidth, { leadSize: 10.5, size: 8.7, gap: 5 });

  doc.fillColor(COLORS.subtle).font('Helvetica-Bold').fontSize(7.5).text(toLines[0].toUpperCase(), 322, y, { characterSpacing: 0.5 });
  const toEnd = textBlock(doc, toLines.slice(1), 322, y + 18, colWidth, { leadSize: 10.5, size: 8.7, gap: 5 });

  const docInfo = joinLines([
    invoice.sourceOrder ? `Source order: ${invoice.sourceOrder}` : '',
    invoice.fulfillmentStatus ? `Fulfillment: ${statusText(invoice.fulfillmentStatus)}` : ''
  ]);
  const docInfoY = Math.max(fromEnd, toEnd, 336) + 8;
  if (docInfo.length) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.2).text(docInfo.join('   |   '), PAGE.left, docInfoY, { width: PAGE.width });
  }
  const ruleY = docInfo.length ? docInfoY + 18 : Math.max(fromEnd, toEnd, 366);
  drawCleanRule(doc, ruleY);
  return ruleY;
};

const drawCleanTableHeader = (doc, y) => {
  doc.rect(PAGE.left, y, PAGE.width, 28).fill(COLORS.light);
  doc.strokeColor(COLORS.line).moveTo(PAGE.left, y).lineTo(PAGE.right, y).stroke();
  doc.moveTo(PAGE.left, y + 28).lineTo(PAGE.right, y + 28).stroke();
  doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.4);
  doc.text('DESCRIPTION', 58, y + 10, { width: 196 });
  doc.text('QTY', 264, y + 10, { width: 32, align: 'right' });
  doc.text('UNIT', 304, y + 10, { width: 38, align: 'right' });
  doc.text('RATE', 352, y + 10, { width: 58, align: 'right' });
  doc.text('TAX', 420, y + 10, { width: 46, align: 'right' });
  doc.text('AMOUNT', 476, y + 10, { width: 62, align: 'right' });
};

const drawCleanTotals = (doc, invoice, x, y) => {
  const paidAmount = Number(invoice.paidAmount ?? (invoice.paymentStatus === 'paid' ? invoice.total : 0));
  const balanceDue = Number(invoice.balanceDue ?? Math.max(Number(invoice.total || 0) - paidAmount, 0));
  const rows = [
    ['Subtotal', currency(invoice.subtotal)],
    ['Discount', `-${currency(invoice.discount?.amount)}`],
    [`Tax (${invoice.tax?.rate ?? 0}%)`, currency(invoice.tax?.amount)],
    ['Total', currency(invoice.total)],
    ['Paid', currency(paidAmount)]
  ];

  rows.forEach(([label, value], index) => {
    const rowY = y + index * 20;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.8).text(label, x, rowY, { width: 92 });
    doc.fillColor(COLORS.ink).font(index === 3 ? 'Helvetica-Bold' : 'Helvetica').fontSize(index === 3 ? 9.6 : 8.8).text(value, x + 98, rowY, { width: 88, align: 'right' });
  });

  doc.strokeColor(COLORS.line).moveTo(x, y + 104).lineTo(x + 186, y + 104).stroke();
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10).text('Balance due', x, y + 120, { width: 92 });
  doc.fontSize(15).text(currency(balanceDue), x + 76, y + 116, { width: 110, align: 'right' });
};

const drawCleanNotes = (doc, invoice, business, x, y) => {
  doc.fillColor(COLORS.subtle).font('Helvetica-Bold').fontSize(7.5).text('NOTES & TERMS', x, y, { characterSpacing: 0.5 });
  const notes = invoice.notes || 'Please make payment by the due date. Quote the invoice number when paying.';
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8.7).text(notes, x, y + 18, { width: 270, lineGap: 3 });
  doc.fillColor(COLORS.muted).fontSize(8).text(`Issued by ${business.businessName || 'QuickInvoice Business'}`, x, y + 104, { width: 170 });
  doc.strokeColor(COLORS.line).moveTo(x + 190, y + 106).lineTo(x + 270, y + 106).stroke();
  doc.fillColor(COLORS.subtle).fontSize(7.5).text('Authorized signatory', x + 190, y + 112, { width: 80, align: 'center' });
};

const drawBillJiFooter = (doc, pageNumber) => {
  const y = PAGE.footer - 2;
  drawCleanRule(doc, y - 14);
  doc.fillColor(COLORS.subtle).font('Helvetica').fontSize(8).text(`Page ${pageNumber}`, PAGE.left, y, { width: 80 });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(8).text('Powered by BillJi', PAGE.left + 178, y, { width: 148, align: 'center' });
  doc.fillColor(COLORS.subtle).font('Helvetica').fontSize(8).text('This is an electronically generated invoice', PAGE.right - 210, y, { width: 210, align: 'right' });
};

export const generateInvoicePdf = (invoice, businessContext) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks = [];
    const business = businessContext?.businessProfile || businessContext || {};
    let pageNumber = 1;

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const addContinuationPage = () => {
      drawBillJiFooter(doc, pageNumber);
      doc.addPage();
      pageNumber += 1;
      doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');
      drawPageCorners(doc);
      doc.fillColor(COLORS.ink).fontSize(11).font('Helvetica-Bold').text(business.businessName || 'QuickInvoice Business', PAGE.left, 42, { width: 260 });
      doc.fillColor(COLORS.muted).fontSize(8.5).font('Helvetica').text(`Invoice ${invoice.invoiceNumber}`, PAGE.right - 180, 42, { width: 180, align: 'right' });
      drawCleanTableHeader(doc, 76);
      return 118;
    };

    drawCleanHeader(doc, invoice, business);
    drawCleanMeta(doc, invoice);
    const partiesBottom = drawCleanParties(doc, invoice, business);

    const tableTop = Math.max(392, partiesBottom + 24);
    drawCleanTableHeader(doc, tableTop);

    let y = tableTop + 42;
    (invoice.items || []).forEach((item) => {
      const nameHeight = doc.font('Helvetica-Bold').fontSize(9.2).heightOfString(item.name, { width: 196 });
      const rowHeight = Math.max(44, nameHeight + (item.sku ? 16 : 2) + 18);

      if (y + rowHeight > PAGE.bottom) {
        y = addContinuationPage();
      }

      doc.fillColor(COLORS.ink).fontSize(9.2).font('Helvetica-Bold').text(item.name, 58, y, { width: 196, lineGap: 2 });
      if (item.sku) {
        doc.fillColor(COLORS.muted).fontSize(7.8).font('Helvetica').text(`SKU: ${item.sku}`, 58, y + nameHeight + 4, { width: 196 });
      }
      doc.fillColor(COLORS.ink).fontSize(8.8).font('Helvetica');
      doc.text(String(item.quantity), 264, y, { width: 32, align: 'right' });
      doc.text(item.unit || 'pcs', 304, y, { width: 38, align: 'right' });
      doc.text(currency(item.price), 352, y, { width: 58, align: 'right' });
      doc.text(item.taxRate ? `${item.taxRate}%` : currency(item.taxAmount || 0), 420, y, { width: 46, align: 'right' });
      doc.font('Helvetica-Bold').text(currency(item.total), 476, y, { width: 62, align: 'right' });
      doc.moveTo(PAGE.left, y + rowHeight - 12).lineTo(PAGE.right, y + rowHeight - 12).stroke(COLORS.line);
      y += rowHeight;
    });

    if (y + 170 > PAGE.bottom) {
      y = addContinuationPage();
    }

    y += 22;
    drawCleanNotes(doc, invoice, business, PAGE.left, y);
    drawCleanTotals(doc, invoice, PAGE.right - 186, y);
    drawStatusStamp(doc, invoice, PAGE.right, y + 154);

    drawBillJiFooter(doc, pageNumber);
    doc.end();
  });
