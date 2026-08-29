import test from 'node:test';
import assert from 'node:assert/strict';
import { generateInvoicePdf } from '../src/services/invoice/pdfService.js';
import { deriveDocumentView } from '../src/services/invoice/invoiceHelpers.js';

// A 1x1 PNG — enough to prove the renderer accepts an embedded data URI.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const baseInvoice = {
  documentType: 'invoice',
  invoiceNumber: 'INV-0001',
  date: '2026-06-11T00:00:00.000Z',
  paymentStatus: 'partial',
  customerSnapshot: { name: 'Acme Corp', phone: '+91 90000 12345', gstNumber: '29ABCDE1234F1Z5' },
  items: [{ name: 'Design consultation', sku: 'DSN-1', quantity: 2, price: 1500, total: 3000 }],
  subtotal: 3000,
  tax: { rate: 18, amount: 540 },
  discount: { amount: 0 },
  total: 3540,
  paidAmount: 1540,
  balanceDue: 2000
};

const pageCount = (buffer) => (buffer.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;

test('renders a PDF buffer for a plain invoice', async () => {
  const pdf = await generateInvoicePdf(baseInvoice, { businessName: 'BillJi Test' });

  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pageCount(pdf), 1);
});

test('embeds the logo and signature when both are inline images', async () => {
  const withImages = await generateInvoicePdf(baseInvoice, {
    businessName: 'BillJi Test',
    logoUrl: PNG,
    invoiceTemplate: { showSignature: true, signatureUrl: PNG }
  });
  const images = (withImages.toString('latin1').match(/\/Subtype \/Image/g) || []).length;

  // One XObject for the logo, one for the signature.
  assert.equal(images, 2);
});

test('a long invoice paginates instead of overflowing one sheet', async () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ name: `Item ${i + 1}`, quantity: 1, price: 100, total: 100 }));
  const pdf = await generateInvoicePdf({ ...baseInvoice, items, subtotal: 6000, total: 6000 }, {});

  assert.ok(pageCount(pdf) > 1, 'expected a 60-line invoice to run past one page');
});

test('a GST document renders its tax summary and stamps a quotation', async () => {
  const gstInvoice = {
    ...baseInvoice,
    documentType: 'quotation',
    documentNumber: 'QTN-0001',
    supplyType: 'intra',
    placeOfSupply: { state: 'KA' },
    items: [{ name: 'Hosting', quantity: 1, price: 4200, total: 4200, taxRate: 18, hsn: '998314' }],
    taxSummary: [{ hsn: '998314', rate: 18, taxableValue: 4200, cgst: 378, sgst: 378, taxAmount: 756 }]
  };

  const view = deriveDocumentView(gstInvoice, {});
  assert.equal(view.doc.watermark, 'QUOTATION');
  assert.ok(view.showHsnColumn);
  assert.deepEqual(view.taxSummaryHeaders, ['HSN/SAC', 'Rate', 'Taxable', 'CGST', 'SGST', 'Total tax']);
  // Payment rows would imply money is owed on an offer.
  assert.equal(view.balanceRow, null);

  const pdf = await generateInvoicePdf(gstInvoice, {});
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

// The invoice is issued in India: amounts can carry ₹ and customer names are routinely
// written in Devanagari or Gurmukhi. React PDF's default Helvetica has none of those
// glyphs, so this asserts the registered families are the ones actually embedded.
test('renders the rupee sign, Hindi and Punjabi from embedded fonts', async () => {
  const pdf = await generateInvoicePdf(
    {
      ...baseInvoice,
      customerSnapshot: { name: 'राम कुमार', phone: '+91 90000 12345' },
      items: [{ name: 'ਮਨੀਸ਼ ਕੁਮਾਰ — consulting', quantity: 1, price: 1500, total: 1500 }],
      notes: 'Total due: ₹1,500.00 — धन्यवाद / ਧੰਨਵਾਦ'
    },
    { businessName: 'BillJi ਟਰੇਡਰਜ਼' }
  );

  const raw = pdf.toString('latin1');
  const baseFonts = raw.match(/\/BaseFont \/[A-Za-z+-]+/g) || [];

  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(baseFonts.some((f) => f.includes('NotoSans-')), 'expected Noto Sans for Latin and ₹');
  assert.ok(baseFonts.some((f) => f.includes('NotoSansDevanagari')), 'expected Noto Sans Devanagari for Hindi');
  assert.ok(baseFonts.some((f) => f.includes('MuktaMahee')), 'expected Mukta Mahee for Punjabi');
  // A base-14 fallback in the output means some run resolved to an unregistered font.
  assert.ok(!raw.includes('Helvetica'), 'no text may fall back to Helvetica');
});
