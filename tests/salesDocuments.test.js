import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Invoice from '../src/models/Invoice.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import Product from '../src/models/Product.js';
import StockMovement from '../src/models/StockMovement.js';
import Customer from '../src/models/Customer.js';
import { IDEMPOTENCY_HEADER } from '../src/contracts/phase0Architecture.js';
import { getReportSummary, invalidateReportSummaryCache } from '../src/services/reportService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);

let seq = 0;
const idempotent = (scope) => {
  seq += 1;
  return { [IDEMPOTENCY_HEADER]: `${scope}-${seq}-${Math.random().toString(36).slice(2, 8)}` };
};

const documentPayload = (customer, product, overrides = {}) => ({
  customerId: customer._id.toString(),
  items: [{ productId: product._id.toString(), quantity: 2, price: 500, taxRate: 5, hsn: '1006' }],
  discountType: 'flat',
  discountValue: 0,
  ...overrides
});

const createDocument = async (token, type, payload, expectStatus = 201) => {
  const res = await api()
    .post(`/api/v1/documents/${type}`)
    .set(authHeader(token))
    .set(idempotent(type))
    .send(payload)
    .expect(expectStatus);
  return res.body;
};

const createInvoice = async (token, customer, product, overrides = {}) => {
  const res = await api()
    .post('/api/v1/invoices')
    .set(authHeader(token))
    .set(idempotent('invoice'))
    .send({ ...documentPayload(customer, product, overrides), allowOversell: true })
    .expect(201);
  return res.body.invoice;
};

const setup = async () => {
  const context = await createTestContext();
  const customer = await createCustomer(context.business, { gstNumber: '27AAPFU0939F1ZV' });
  const product = await createProduct(context.business, { stockQuantity: 100, price: 500, taxRate: 5, hsn: '1006' });
  return { ...context, customer, product };
};

const stockOf = async (productId) => (await Product.findById(productId).lean()).stockQuantity;

const cancelDocument = (token, type, id, expectStatus = 200) =>
  api().post(`/api/v1/documents/${type}/${id}/cancel`).set(authHeader(token)).send({}).expect(expectStatus);

const duesOf = async (customerId) => (await Customer.findById(customerId).lean()).outstandingDues;

const creditOf = async (customerId) => (await Customer.findById(customerId).lean()).availableCredit;

// Net movement of a document's ledger rows on one account: originals plus the
// compensating 'adjustment' rows cancellation posts. Zero means "no live effect".
const ledgerNet = async (documentId, account) => {
  const entries = await LedgerEntry.find({ salesDocument: documentId, account }).lean();
  return entries.reduce((sum, entry) => sum + (entry.direction === 'credit' ? entry.amount : -entry.amount), 0);
};

describe('quotation', () => {
  it('uses its own number series and never touches stock or the ledger', async () => {
    const { token, customer, product } = await setup();

    const { document } = await createDocument(token, 'quotation', documentPayload(customer, product));

    assert.match(document.documentNumber, /^QTN-/);
    // invoiceNumber is left unset so it cannot collide with the invoice series.
    assert.ok(!document.invoiceNumber);
    assert.equal(await stockOf(product._id), 100);
    assert.equal(await StockMovement.countDocuments({ salesDocument: document._id }), 0);
    assert.equal(await LedgerEntry.countDocuments({ salesDocument: document._id }), 0);
    assert.equal(document.total, 1050);
  });

  it('converts to an invoice once, deducting stock at that point', async () => {
    const { token, customer, product } = await setup();
    const { document } = await createDocument(token, 'quotation', documentPayload(customer, product));

    const res = await api()
      .post(`/api/v1/documents/quotation/${document._id}/convert`)
      .set(authHeader(token))
      .set(idempotent('convert'))
      .expect(201);

    assert.match(res.body.invoice.invoiceNumber, /^TST-/);
    assert.equal(await stockOf(product._id), 98);

    // The quotation is spent, and a second attempt is refused rather than duplicating.
    const source = await Invoice.findById(document._id).lean();
    assert.equal(source.documentStatus, 'void');

    const second = await api()
      .post(`/api/v1/documents/quotation/${document._id}/convert`)
      .set(authHeader(token))
      .set(idempotent('convert'))
      .expect(409);
    assert.equal(second.body.details?.code || second.body.code, 'DOCUMENT_ALREADY_INVOICED');
  });

  it('refuses to convert a cancelled quotation', async () => {
    const { token, customer, product } = await setup();
    const { document } = await createDocument(token, 'quotation', documentPayload(customer, product));

    await api().post(`/api/v1/documents/quotation/${document._id}/cancel`).set(authHeader(token)).send({}).expect(200);

    await api()
      .post(`/api/v1/documents/quotation/${document._id}/convert`)
      .set(authHeader(token))
      .set(idempotent('convert'))
      .expect(409);
  });

  it('resolves the invoice it was converted into, and only that invoice', async () => {
    const { token, customer, product } = await setup();
    const { document } = await createDocument(token, 'quotation', documentPayload(customer, product));

    // Before conversion there is nothing to link to.
    const before = await api().get(`/api/v1/documents/quotation/${document._id}`).set(authHeader(token)).expect(200);
    assert.equal(before.body.document.linkedInvoice, null);

    // An unrelated invoice exists alongside it and must never be picked up.
    const unrelated = await createInvoice(token, customer, product);

    const converted = await api()
      .post(`/api/v1/documents/quotation/${document._id}/convert`)
      .set(authHeader(token))
      .set(idempotent('convert'))
      .expect(201);

    const after = await api().get(`/api/v1/documents/quotation/${document._id}`).set(authHeader(token)).expect(200);
    assert.equal(after.body.document.linkedInvoice.id, converted.body.invoice._id);
    assert.equal(after.body.document.linkedInvoice.invoiceNumber, converted.body.invoice.invoiceNumber);
    assert.notEqual(after.body.document.linkedInvoice.id, unrelated._id);
  });

  it('does not leak a converted invoice to another business or to an anonymous caller', async () => {
    const { token, customer, product } = await setup();
    const { document } = await createDocument(token, 'quotation', documentPayload(customer, product));
    await api()
      .post(`/api/v1/documents/quotation/${document._id}/convert`)
      .set(authHeader(token))
      .set(idempotent('convert'))
      .expect(201);

    // A second business cannot even read the quotation, so it can never read its invoice.
    const other = await createTestContext();
    await api().get(`/api/v1/documents/quotation/${document._id}`).set(authHeader(other.token)).expect(404);
    await api().get(`/api/v1/documents/quotation/${document._id}`).expect(401);
  });
});

describe('delivery challan', () => {
  it('moves stock out but posts nothing to the ledger', async () => {
    const { token, customer, product } = await setup();

    const { document } = await createDocument(token, 'delivery_challan', documentPayload(customer, product));

    assert.match(document.documentNumber, /^DC-/);
    assert.equal(await stockOf(product._id), 98);
    assert.equal(await StockMovement.countDocuments({ salesDocument: document._id }), 1);
    assert.equal(await LedgerEntry.countDocuments({ salesDocument: document._id }), 0);
  });

  it('does not deduct the same stock twice when invoiced', async () => {
    const { token, customer, product } = await setup();
    const { document } = await createDocument(token, 'delivery_challan', documentPayload(customer, product));
    assert.equal(await stockOf(product._id), 98);

    await api()
      .post(`/api/v1/documents/delivery_challan/${document._id}/convert`)
      .set(authHeader(token))
      .set(idempotent('convert'))
      .expect(201);

    // The goods already left on the challan.
    assert.equal(await stockOf(product._id), 98);
  });

  it('restores stock when cancelled', async () => {
    const { token, customer, product } = await setup();
    const { document } = await createDocument(token, 'delivery_challan', documentPayload(customer, product));

    await api().post(`/api/v1/documents/delivery_challan/${document._id}/cancel`).set(authHeader(token)).send({}).expect(200);

    assert.equal(await stockOf(product._id), 100);
  });

  // The detail response reports what the document did to stock from the movements it wrote,
  // so a client states a fact instead of inferring one from the document type.
  it('reports the stock it actually moved, and the reversal once cancelled', async () => {
    const { token, customer, product } = await setup();
    const { document } = await createDocument(token, 'delivery_challan', documentPayload(customer, product));

    const issued = await api().get(`/api/v1/documents/delivery_challan/${document._id}`).set(authHeader(token)).expect(200);
    assert.deepEqual(issued.body.document.stockEffect, { products: 1, quantity: 2, reversed: false });

    await api().post(`/api/v1/documents/delivery_challan/${document._id}/cancel`).set(authHeader(token)).send({}).expect(200);

    const cancelled = await api().get(`/api/v1/documents/delivery_challan/${document._id}`).set(authHeader(token)).expect(200);
    assert.deepEqual(cancelled.body.document.stockEffect, { products: 1, quantity: 2, reversed: true });
  });

  // A line with no tracked product moves nothing, which is exactly the case a rules-table
  // guess gets wrong.
  it('reports no stock movement for a challan of untracked lines', async () => {
    const { token, customer } = await setup();
    const { document } = await createDocument(token, 'delivery_challan', {
      customerId: customer._id.toString(),
      items: [{ name: 'Loading charges', quantity: 1, price: 200, taxRate: 5 }],
      discountType: 'flat',
      discountValue: 0
    });

    const res = await api().get(`/api/v1/documents/delivery_challan/${document._id}`).set(authHeader(token)).expect(200);
    assert.deepEqual(res.body.document.stockEffect, { products: 0, quantity: 0, reversed: false });
  });

  it('reports no stock effect on a document type that never moves stock', async () => {
    const { token, customer, product } = await setup();
    const { document } = await createDocument(token, 'quotation', documentPayload(customer, product));

    const res = await api().get(`/api/v1/documents/quotation/${document._id}`).set(authHeader(token)).expect(200);
    assert.equal(res.body.document.stockEffect, undefined);
  });
});

describe('credit note', () => {
  it('restores stock and posts a reversing ledger pair', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);
    assert.equal(await stockOf(product._id), 98);

    const { document } = await createDocument(
      token,
      'credit_note',
      documentPayload(customer, product, { sourceInvoiceId: invoice._id, reason: 'Goods returned' })
    );

    assert.match(document.documentNumber, /^CN-/);
    // Goods came back.
    assert.equal(await stockOf(product._id), 100);

    const entries = await LedgerEntry.find({ business: business._id, sourceType: 'credit_note' }).lean();
    assert.equal(entries.length, 2);
    // Revenue reversed and a liability to the customer created. The receivable on the
    // source invoice is untouched: they still owe it until the credit is applied.
    assert.deepEqual(
      entries.map((entry) => `${entry.account}:${entry.direction}`).sort(),
      ['customer_credits:credit', 'sales:debit']
    );
    assert.equal(entries.filter((entry) => entry.account === 'accounts_receivable').length, 0);
    assert.equal(entries[0].amount, 1050);
  });

  it('leaves the due standing and creates applicable credit instead', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);

    // Half the invoice is credited back (1 unit of 2).
    await createDocument(token, 'credit_note', {
      customerId: customer._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1, price: 500, taxRate: 5, hsn: '1006' }],
      sourceInvoiceId: invoice._id
    });

    // No auto-apply: the customer still owes the full invoice, and separately holds 525
    // of credit they can choose to spend. Both are non-zero at once.
    assert.equal(await duesOf(customer._id), 1050);
    assert.equal(await creditOf(customer._id), 525);
  });

  it('keeps every outstanding surface agreeing after a credit note', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);

    await createDocument(token, 'credit_note', {
      customerId: customer._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1, price: 500, taxRate: 5, hsn: '1006' }],
      sourceInvoiceId: invoice._id
    });

    const outstanding = await api()
      .get(`/api/v1/payments/customers/${customer._id}/outstanding`)
      .set(authHeader(token))
      .expect(200);

    invalidateReportSummaryCache(business._id);
    const report = await getReportSummary(business._id);

    // The denormalised mirror, the per-invoice allocation walk and the report aggregate
    // all read the same number — the defect that made them disagree was the credit note
    // netting off in only one of them.
    assert.equal(await duesOf(customer._id), 1050);
    assert.equal(outstanding.body.totalOutstanding, 1050);
    assert.equal(report.dues.totalOutstanding, 1050);
  });

  it('rejects a credit note that exceeds what is left on the invoice', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);

    // First note takes the full invoice value.
    await createDocument(token, 'credit_note', documentPayload(customer, product, { sourceInvoiceId: invoice._id }));

    const res = await api()
      .post('/api/v1/documents/credit_note')
      .set(authHeader(token))
      .set(idempotent('credit_note'))
      .send(documentPayload(customer, product, { sourceInvoiceId: invoice._id }))
      .expect(409);

    assert.equal(res.body.details?.code || res.body.code, 'CREDIT_NOTE_EXCEEDS_INVOICE');
  });

  it('requires a source invoice, and refuses a cancelled one', async () => {
    const { token, customer, product } = await setup();

    await api()
      .post('/api/v1/documents/credit_note')
      .set(authHeader(token))
      .set(idempotent('credit_note'))
      .send(documentPayload(customer, product))
      .expect(422);

    const invoice = await createInvoice(token, customer, product);
    await api().patch(`/api/v1/invoices/${invoice._id}/status`).set(authHeader(token)).send({ status: 'cancelled' }).expect(200);

    await api()
      .post('/api/v1/documents/credit_note')
      .set(authHeader(token))
      .set(idempotent('credit_note'))
      .send(documentPayload(customer, product, { sourceInvoiceId: invoice._id }))
      .expect(409);
  });

  it('takes the credit off the books when the credit note is cancelled', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);
    const { document } = await createDocument(
      token,
      'credit_note',
      documentPayload(customer, product, { sourceInvoiceId: invoice._id })
    );

    // The invoice was never reduced by the note, so only the credit moves.
    assert.equal(await duesOf(customer._id), 1050);
    assert.equal(await creditOf(customer._id), 1050);

    await cancelDocument(token, 'credit_note', document._id);

    assert.equal(await duesOf(customer._id), 1050);
    assert.equal(await creditOf(customer._id), 0);
  });

  it('leaves no live ledger effect once the credit note is cancelled', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);
    const { document } = await createDocument(
      token,
      'credit_note',
      documentPayload(customer, product, { sourceInvoiceId: invoice._id })
    );

    // Issued: customer credit created, sales debited.
    assert.equal(await ledgerNet(document._id, 'customer_credits'), 1050);
    assert.equal(await ledgerNet(document._id, 'sales'), -1050);

    await cancelDocument(token, 'credit_note', document._id);

    // Originals kept for audit, compensating entries net them to zero.
    assert.equal(await ledgerNet(document._id, 'customer_credits'), 0);
    assert.equal(await ledgerNet(document._id, 'sales'), 0);
    assert.equal(await LedgerEntry.countDocuments({ salesDocument: document._id, sourceType: 'credit_note' }), 2);
    assert.equal(await LedgerEntry.countDocuments({ salesDocument: document._id, sourceType: 'adjustment' }), 2);
  });

  it('takes the returned stock back out when the credit note is cancelled', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);
    const { document } = await createDocument(
      token,
      'credit_note',
      documentPayload(customer, product, { sourceInvoiceId: invoice._id })
    );
    assert.equal(await stockOf(product._id), 100);

    await cancelDocument(token, 'credit_note', document._id);

    assert.equal(await stockOf(product._id), 98);
  });

  it('cannot reverse twice when cancelled repeatedly', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);
    const { document } = await createDocument(
      token,
      'credit_note',
      documentPayload(customer, product, { sourceInvoiceId: invoice._id })
    );

    await cancelDocument(token, 'credit_note', document._id);
    await cancelDocument(token, 'credit_note', document._id);
    await cancelDocument(token, 'credit_note', document._id);

    assert.equal(await LedgerEntry.countDocuments({ salesDocument: document._id, sourceType: 'adjustment' }), 2);
    assert.equal(await ledgerNet(document._id, 'customer_credits'), 0);
    assert.equal(await duesOf(customer._id), 1050);
    assert.equal(await creditOf(customer._id), 0);
    assert.equal(await stockOf(product._id), 98);
    assert.equal(await StockMovement.countDocuments({ salesDocument: document._id }), 2);
  });

  it('withdraws a partial credit note\'s credit when it is cancelled', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);

    // One of the two units comes back.
    const { document } = await createDocument(token, 'credit_note', {
      customerId: customer._id.toString(),
      items: [{ productId: product._id.toString(), quantity: 1, price: 500, taxRate: 5, hsn: '1006' }],
      sourceInvoiceId: invoice._id
    });

    assert.equal(await duesOf(customer._id), 1050);
    assert.equal(await creditOf(customer._id), 525);
    assert.equal(await stockOf(product._id), 99);

    await cancelDocument(token, 'credit_note', document._id);

    assert.equal(await duesOf(customer._id), 1050);
    assert.equal(await creditOf(customer._id), 0);
    assert.equal(await stockOf(product._id), 98);
    assert.equal(await ledgerNet(document._id, 'customer_credits'), 0);
  });

  it('cancels a credit note whose lines are custom, with no product to restock', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);

    const { document } = await createDocument(token, 'credit_note', {
      customerId: customer._id.toString(),
      items: [{ name: 'Freight refund', quantity: 1, price: 200, taxRate: 5 }],
      sourceInvoiceId: invoice._id
    });

    assert.equal(await duesOf(customer._id), 1050);
    assert.equal(await creditOf(customer._id), 210);
    // Nothing to move: a custom line has no product behind it.
    assert.equal(await StockMovement.countDocuments({ salesDocument: document._id }), 0);

    await cancelDocument(token, 'credit_note', document._id);

    assert.equal(await duesOf(customer._id), 1050);
    assert.equal(await creditOf(customer._id), 0);
    assert.equal(await stockOf(product._id), 98);
    assert.equal(await ledgerNet(document._id, 'customer_credits'), 0);
    assert.equal(await StockMovement.countDocuments({ salesDocument: document._id }), 0);
  });

  it('cancels a credit note that belongs to no customer record', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);

    // A typed-in buyer: snapshot only, no Customer row to carry a balance.
    const { document } = await createDocument(token, 'credit_note', {
      customer: { name: 'Counter Buyer', phone: '9000000009' },
      items: [{ productId: product._id.toString(), quantity: 2, price: 500, taxRate: 5, hsn: '1006' }],
      sourceInvoiceId: invoice._id
    });
    assert.equal(document.customer, null);
    assert.equal(await stockOf(product._id), 100);

    await cancelDocument(token, 'credit_note', document._id);

    assert.equal(await stockOf(product._id), 98);
    assert.equal(await ledgerNet(document._id, 'customer_credits'), 0);
    // The named customer's own balance was never touched by a note that is not theirs.
    assert.equal(await duesOf(customer._id), 0);
    assert.equal(await creditOf(customer._id), 0);
  });

  it('inherits the original supply place, so the reversal files against the same state', async () => {
    const { business, token, product } = await setup();
    // Supplier state is half of every inter/intra decision; the base fixture has no GSTIN.
    business.gstNumber = '27AAPFU0939F1ZV';
    await business.save();
    const delhiCustomer = await createCustomer(business, { name: 'Delhi Buyer', phone: '9000000001', gstNumber: '07AAPFU0939F1ZV' });
    const invoice = await createInvoice(token, delhiCustomer, product);
    assert.equal(invoice.supplyType, 'inter');

    const { document } = await createDocument(
      token,
      'credit_note',
      documentPayload(delhiCustomer, product, { sourceInvoiceId: invoice._id })
    );

    assert.equal(document.supplyType, 'inter');
    assert.equal(document.placeOfSupply.code, '07');
    // Inter-state reversal carries IGST only.
    assert.equal(document.taxSummary[0].igst, 50);
    assert.equal(document.taxSummary[0].cgst, 0);
  });
});

describe('document listing and isolation', () => {
  it('lists only the requested type', async () => {
    const { token, customer, product } = await setup();
    await createDocument(token, 'quotation', documentPayload(customer, product));
    await createDocument(token, 'delivery_challan', documentPayload(customer, product));

    const quotes = await api().get('/api/v1/documents/quotation').set(authHeader(token)).expect(200);
    assert.equal(quotes.body.documents.length, 1);
    assert.match(quotes.body.documents[0].documentNumber, /^QTN-/);

    const challans = await api().get('/api/v1/documents/delivery_challan').set(authHeader(token)).expect(200);
    assert.equal(challans.body.documents.length, 1);
  });

  it('keeps quotations out of the invoice list and reports', async () => {
    const { token, customer, product } = await setup();
    await createDocument(token, 'quotation', documentPayload(customer, product));

    const invoices = await api().get('/api/v1/invoices').set(authHeader(token)).expect(200);
    assert.equal(invoices.body.invoices.length, 0);
  });

  it('rejects an unknown document type', async () => {
    const { token } = await createTestContext();

    await api().get('/api/v1/documents/nonsense').set(authHeader(token)).expect(422);
  });

  it('never returns another business\'s documents', async () => {
    const mine = await createTestContext();
    const theirs = await setup();
    await createDocument(theirs.token, 'quotation', documentPayload(theirs.customer, theirs.product));

    const res = await api().get('/api/v1/documents/quotation').set(authHeader(mine.token)).expect(200);
    assert.equal(res.body.documents.length, 0);
  });
});

describe('credit notes in GST returns', () => {
  it('files under CDNR and nets off the GSTR-3B liability', async () => {
    const { business, token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);
    const { document } = await createDocument(
      token,
      'credit_note',
      documentPayload(customer, product, { sourceInvoiceId: invoice._id, reason: 'Returned' })
    );

    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const gstr1 = await api().get(`/api/v1/gst/gstr1?period=${period}`).set(authHeader(token)).expect(200);
    assert.equal(gstr1.body.report.counts.cdnr, 1);
    const [note] = gstr1.body.report.sections.cdnr;
    assert.equal(note.noteNumber, document.documentNumber);
    assert.equal(note.originalInvoiceNumber, invoice.invoiceNumber);
    assert.equal(note.documentType, 'C');
    // The supply itself is still reported in full; the credit note is its own section.
    assert.equal(gstr1.body.report.totals.taxableValue, 1000);
    assert.equal(gstr1.body.report.totals.creditNoteTaxableValue, 1000);

    const gstr3b = await api().get(`/api/v1/gst/gstr3b?period=${period}`).set(authHeader(token)).expect(200);
    // Invoice and full credit note cancel out.
    assert.equal(gstr3b.body.report.outwardTaxableSupplies.taxableValue, 0);
    assert.equal(gstr3b.body.report.outwardTaxableSupplies.cgst, 0);
    assert.equal(gstr3b.body.report.creditNoteCount, 1);
    assert.equal(String(business._id), String(business._id));
  });

  it('excludes a cancelled credit note from CDNR', async () => {
    const { token, customer, product } = await setup();
    const invoice = await createInvoice(token, customer, product);
    const { document } = await createDocument(
      token,
      'credit_note',
      documentPayload(customer, product, { sourceInvoiceId: invoice._id })
    );
    await api().post(`/api/v1/documents/credit_note/${document._id}/cancel`).set(authHeader(token)).send({}).expect(200);

    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const gstr1 = await api().get(`/api/v1/gst/gstr1?period=${period}`).set(authHeader(token)).expect(200);

    assert.equal(gstr1.body.report.counts.cdnr, 0);
  });
});
