import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceHtml } from '../src/services/invoiceHtml.js';

const baseDocument = {
  documentNumber: 'QTN-0001',
  date: '2026-07-31T00:00:00.000Z',
  customerSnapshot: { name: 'Acme Traders', phone: '9999999999' },
  items: [{ name: 'Khari', quantity: 3, price: 90, total: 270 }],
  subtotal: 270,
  tax: { rate: 18, amount: 48.6 },
  discount: { amount: 0 },
  total: 318.6,
  paymentStatus: 'unpaid'
};

test('a quotation is stamped and cannot read as a tax invoice', () => {
  const html = buildInvoiceHtml({ ...baseDocument, documentType: 'quotation' }, { businessName: 'BillJi Test' });

  assert.match(html, /<div class="title">QUOTATION<\/div>/);
  assert.match(html, /class="watermark">QUOTATION</);
  assert.match(html, /NOT A TAX INVOICE/);
  assert.match(html, /not a tax invoice or a bill/);
  // Payment/balance rows would imply money is owed on an offer.
  assert.ok(!html.includes('Balance due'));
  assert.ok(!html.includes('>Paid<'));
});

test('a delivery challan carries its own title and disclaimer', () => {
  const html = buildInvoiceHtml({ ...baseDocument, documentType: 'delivery_challan' }, {});

  assert.match(html, /<div class="title">DELIVERY CHALLAN<\/div>/);
  assert.match(html, /class="watermark">CHALLAN</);
  assert.match(html, /NOT A TAX INVOICE/);
});

test('an invoice is unchanged — no watermark, no disclaimer, payment rows intact', () => {
  const html = buildInvoiceHtml({ ...baseDocument, documentType: 'invoice', invoiceNumber: 'INV-0001' }, {});

  assert.match(html, /<div class="title">INVOICE<\/div>/);
  assert.ok(!html.includes('class="watermark"'));
  assert.ok(!html.includes('NOT A TAX INVOICE'));
  assert.match(html, /Balance due/);
});
