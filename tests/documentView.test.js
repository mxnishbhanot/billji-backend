import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveDocumentView } from '../src/services/invoice/invoiceHelpers.js';

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

const labels = (view) => view.totalRows.map((row) => row.label);
const valueOf = (view, label) => view.totalRows.find((row) => row.label === label)?.value;

test('a quotation is stamped and cannot read as a tax invoice', () => {
  const view = deriveDocumentView({ ...baseDocument, documentType: 'quotation' }, { businessName: 'BillJi Test' });

  assert.equal(view.doc.title, 'QUOTATION');
  assert.equal(view.doc.watermark, 'QUOTATION');
  assert.match(view.doc.disclaimer, /not a tax invoice or a bill/);
  // Payment/balance rows would imply money is owed on an offer.
  assert.equal(view.showPaymentRows, false);
  assert.equal(view.balanceRow, null);
  assert.ok(!labels(view).includes('Paid'));
});

test('a delivery challan carries its own title and disclaimer', () => {
  const view = deriveDocumentView({ ...baseDocument, documentType: 'delivery_challan' }, {});

  assert.equal(view.doc.title, 'DELIVERY CHALLAN');
  assert.equal(view.doc.watermark, 'CHALLAN');
  assert.match(view.doc.disclaimer, /not a tax invoice or a bill/);
});

test('an invoice is unchanged — no watermark, no disclaimer, payment rows intact', () => {
  const view = deriveDocumentView({ ...baseDocument, documentType: 'invoice', invoiceNumber: 'INV-0001' }, {});

  assert.equal(view.doc.title, 'INVOICE');
  assert.equal(view.doc.watermark, undefined);
  assert.equal(view.doc.disclaimer, undefined);
  assert.equal(view.balanceRow?.label, 'Balance due');
});

// The printed sheet has to say where the settlement came from: "Paid" is money the customer
// handed over, "Credit applied" is credit they already held. Merging them would put a figure
// on their copy that ties to no receipt.
const creditedInvoice = {
  ...baseDocument,
  documentType: 'invoice',
  invoiceNumber: 'INV-0002',
  total: 1000,
  tax: { rate: 0, amount: 0 },
  subtotal: 1000
};

test('an invoice settled partly by credit prints the credit as its own line', () => {
  const view = deriveDocumentView(
    { ...creditedInvoice, paymentStatus: 'partial', paidAmount: 200, creditApplied: 300, balanceDue: 500 },
    {}
  );

  assert.match(valueOf(view, 'Paid'), /200/);
  assert.match(valueOf(view, 'Credit applied'), /300/);
  assert.match(view.balanceRow.value, /500/);
});

test('an invoice settled entirely by credit reports no money received', () => {
  const view = deriveDocumentView(
    { ...creditedInvoice, paymentStatus: 'paid', paidAmount: 0, creditApplied: 1000, balanceDue: 0 },
    {}
  );

  // 'paid' used to mean "the whole total was received"; with credit that is no longer true.
  assert.match(valueOf(view, 'Paid'), /0\.00/);
  assert.match(valueOf(view, 'Credit applied'), /1,000/);
});

test('an invoice with no credit prints exactly what it printed before', () => {
  const view = deriveDocumentView({ ...creditedInvoice, paymentStatus: 'partial', paidAmount: 400, balanceDue: 600 }, {});

  assert.ok(!labels(view).includes('Credit applied'));
  assert.match(valueOf(view, 'Paid'), /400/);
});
