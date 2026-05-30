import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const currency = (value) => `Rs. ${Number(value || 0).toFixed(2)}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BILLJI_LOGO_PATH = path.resolve(__dirname, '../../../mobile/assets/billji-powered-logo.png');
const PAGE = { left: 48, right: 548, width: 500, bottom: 730 };
const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  light: '#f8fafc',
  line: '#e2e8f0',
  brand: '#f97316',
  brandSoft: '#fff7ed',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626'
};

let billjiLogoBuffer;

const loadBilljiLogo = () => {
  if (billjiLogoBuffer !== undefined) return billjiLogoBuffer;

  try {
    billjiLogoBuffer = fs.readFileSync(BILLJI_LOGO_PATH);
  } catch {
    billjiLogoBuffer = null;
  }

  return billjiLogoBuffer;
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

const drawPoweredBy = (doc) => {
  const logo = loadBilljiLogo();
  const separatorY = 748;
  const y = 765;
  const logoSize = 22;
  const text = 'Powered by';
  const textWidth = 52;
  const groupWidth = logo ? textWidth + 10 + logoSize : textWidth;
  const x = PAGE.left + (PAGE.width - groupWidth) / 2;

  doc.save();
  doc.moveTo(PAGE.left, separatorY).lineTo(PAGE.right, separatorY).stroke(COLORS.line);
  doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica-Bold').text(text, x, y + 7, { width: textWidth });
  if (logo) {
    drawImage(doc, logo, x + textWidth + 10, y, { fit: [logoSize, logoSize] });
  }
  doc.restore();
};

const drawBusinessLogo = (doc, logoUrl) => {
  const logo = logoBufferFromDataUrl(logoUrl);

  if (!logo) {
    return false;
  }

  const drawn = drawImage(doc, logo, PAGE.left, 70, { fit: [44, 44] });
  if (drawn) doc.roundedRect(PAGE.left, 70, 44, 44, 10).stroke(COLORS.line);
  return drawn;
};

const statusColor = (status = '') => {
  if (status === 'paid') return COLORS.success;
  if (status === 'cancelled') return COLORS.danger;
  return COLORS.warning;
};

const drawStatusBadge = (doc, status, x, y) => {
  const label = String(status || 'pending').toUpperCase();
  const width = Math.max(doc.font('Helvetica-Bold').fontSize(8).widthOfString(label) + 22, 70);
  doc.roundedRect(x - width, y, width, 20, 10).fill(statusColor(status));
  doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold').text(label, x - width, y + 6, { width, align: 'center' });
};

const drawInfoCard = (doc, title, lines, x, y, width, height) => {
  doc.roundedRect(x, y, width, height, 14).fillAndStroke(COLORS.light, COLORS.line);
  doc.fillColor(COLORS.brand).fontSize(8).font('Helvetica-Bold').text(title.toUpperCase(), x + 16, y + 16, { characterSpacing: 0.4 });
  lines.filter(Boolean).forEach((line, index) => {
    doc
      .fillColor(index === 0 ? COLORS.ink : COLORS.muted)
      .fontSize(index === 0 ? 11 : 9)
      .font(index === 0 ? 'Helvetica-Bold' : 'Helvetica')
      .text(line, x + 16, y + 36 + index * 15, { width: width - 32 });
  });
};

const drawTableHeader = (doc, y) => {
  doc.roundedRect(PAGE.left, y, PAGE.width, 32, 10).fill(COLORS.ink);
  doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold');
  doc.text('ITEM', 64, y + 12);
  doc.text('QTY', 305, y + 12, { width: 45, align: 'right' });
  doc.text('RATE', 370, y + 12, { width: 70, align: 'right' });
  doc.text('TOTAL', 458, y + 12, { width: 74, align: 'right' });
};

export const generateInvoicePdf = (invoice, businessContext) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks = [];
    const business = businessContext?.businessProfile || businessContext || {};

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');
    doc.roundedRect(PAGE.left, 40, PAGE.width, 6, 3).fill(COLORS.brand);

    const hasLogo = drawBusinessLogo(doc, business.logoUrl);
    const businessX = hasLogo ? 108 : PAGE.left;
    const businessWidth = hasLogo ? 255 : 315;

    doc.fillColor(COLORS.ink).fontSize(20).font('Helvetica-Bold').text(business.businessName || 'QuickInvoice Business', businessX, 68, {
      width: businessWidth
    });
    doc.fontSize(9).font('Helvetica').fillColor(COLORS.muted).text(business.address || 'Business address not set', businessX, 94, {
      width: businessWidth
    });
    doc.text(`${business.phone || ''}${business.email ? ` | ${business.email}` : ''}`, businessX, 119, { width: businessWidth });
    if (business.gstNumber) {
      doc.text(`GST: ${business.gstNumber}`, businessX, 134, { width: businessWidth });
    }

    doc.fillColor(COLORS.ink).fontSize(28).font('Helvetica-Bold').text('INVOICE', 372, 68, { width: 176, align: 'right' });
    doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica').text(`# ${invoice.invoiceNumber}`, 372, 104, { width: 176, align: 'right' });
    drawStatusBadge(doc, invoice.status, PAGE.right, 126);

    drawInfoCard(
      doc,
      'Bill To',
      [invoice.customerSnapshot.name, invoice.customerSnapshot.phone, invoice.customerSnapshot.email, invoice.customerSnapshot.address],
      PAGE.left,
      176,
      300,
      110
    );
    drawInfoCard(
      doc,
      'Invoice Details',
      [
        `Date: ${new Date(invoice.date).toLocaleDateString()}`,
        invoice.dueDate ? `Due: ${new Date(invoice.dueDate).toLocaleDateString()}` : 'Due: On receipt',
        `Invoice: ${invoice.invoiceNumber}`
      ],
      368,
      176,
      180,
      110
    );

    const tableTop = 320;
    drawTableHeader(doc, tableTop);

    let y = tableTop + 44;
    invoice.items.forEach((item, index) => {
      if (y > 650) {
        drawPoweredBy(doc);
        doc.addPage();
        doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');
        drawTableHeader(doc, 60);
        y = 104;
      }

      if (index % 2 === 1) doc.roundedRect(PAGE.left, y - 10, PAGE.width, 38, 8).fill(COLORS.light);
      doc.fillColor(COLORS.ink).fontSize(10).font('Helvetica-Bold').text(item.name, 64, y, { width: 210 });
      if (item.sku) {
        doc.fillColor(COLORS.muted).fontSize(8).font('Helvetica').text(`SKU: ${item.sku}`, 64, y + 14);
      }
      doc.fillColor(COLORS.ink).fontSize(10).font('Helvetica');
      doc.text(String(item.quantity), 310, y, { width: 40, align: 'right' });
      doc.text(currency(item.price), 370, y, { width: 70, align: 'right' });
      doc.font('Helvetica-Bold').text(currency(item.total), 458, y, { width: 74, align: 'right' });
      doc.moveTo(64, y + 28).lineTo(532, y + 28).stroke(COLORS.line);
      y += 40;
    });

    if (y > 590) {
      drawPoweredBy(doc);
      doc.addPage();
      doc.rect(0, 0, doc.page.width, doc.page.height).fill('#ffffff');
      y = 70;
    }

    y += 18;
    const totalsY = y;
    const totalsX = 342;
    doc.roundedRect(totalsX, totalsY, 206, 104, 14).fillAndStroke(COLORS.light, COLORS.line);
    doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica').text('Subtotal', totalsX + 18, totalsY + 18);
    doc.text(currency(invoice.subtotal), totalsX + 100, totalsY + 18, { width: 82, align: 'right' });
    doc.text('Discount', totalsX + 18, totalsY + 38);
    doc.text(`-${currency(invoice.discount.amount)}`, totalsX + 100, totalsY + 38, { width: 82, align: 'right' });
    doc.text(`Tax (${invoice.tax.rate}%)`, totalsX + 18, totalsY + 58);
    doc.text(currency(invoice.tax.amount), totalsX + 100, totalsY + 58, { width: 82, align: 'right' });
    doc.moveTo(totalsX + 18, totalsY + 79).lineTo(totalsX + 188, totalsY + 79).stroke(COLORS.line);
    doc.fillColor(COLORS.ink).fontSize(12).font('Helvetica-Bold').text('Grand Total', totalsX + 18, totalsY + 86);
    doc.fillColor(COLORS.brand).fontSize(12).font('Helvetica-Bold').text(currency(invoice.total), totalsX + 100, totalsY + 86, { width: 82, align: 'right' });

    if (invoice.notes) {
      doc.roundedRect(PAGE.left, totalsY, 260, 82, 14).fillAndStroke(COLORS.brandSoft, '#fed7aa');
      doc.fillColor(COLORS.brand).fontSize(8).font('Helvetica-Bold').text('NOTES', PAGE.left + 16, totalsY + 16);
      doc.fillColor(COLORS.muted).fontSize(9).font('Helvetica').text(invoice.notes, PAGE.left + 16, totalsY + 34, { width: 228 });
    }

    drawPoweredBy(doc);
    doc.end();
  });
