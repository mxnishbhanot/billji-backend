import './helpers/exportEnv.js';
import crypto from 'crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../src/app.js';
import DataExport from '../src/models/DataExport.js';
import Invoice from '../src/models/Invoice.js';
import OutboxEvent from '../src/models/OutboxEvent.js';
import { DOMAIN_EVENTS } from '../src/services/eventBus.js';
import { dispatchOutboxEvent } from '../src/services/eventDispatcher.js';
import LedgerEntry from '../src/models/LedgerEntry.js';
import Payment from '../src/models/Payment.js';
import User from '../src/models/User.js';
import { buildExportArchive, buildExportFiles } from '../src/modules/exports/archive.js';
import { CSV_BOM, toCsv } from '../src/modules/exports/csv.js';
import { EXPORT_COLLECTIONS } from '../src/modules/exports/manifest.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createCustomer, createProduct, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

let invoiceSeq = 0;

const seedBusiness = async ({ customerName, shareToken }) => {
  const context = await createTestContext();
  const { business, user } = context;
  const customer = await createCustomer(business, { name: customerName, phone: '9800000000' });
  invoiceSeq += 1;
  const product = await createProduct(business, { name: `${customerName} Widget`, sku: `SKU-${invoiceSeq}` });

  const invoice = await Invoice.create({
    business: business._id,
    customer: customer._id,
    createdBy: user._id,
    documentType: 'invoice',
    documentNumber: `EXP-${String(invoiceSeq).padStart(4, '0')}`,
    customerSnapshot: { name: customerName, phone: '9800000000' },
    items: [
      { product: product._id, name: 'Widget', quantity: 2, price: 100, total: 200 },
      { product: null, name: 'Custom job', quantity: 1, price: 50, total: 50, isCustom: true }
    ],
    subtotal: 250,
    total: 250,
    paidAmount: 100,
    balanceDue: 150,
    paymentStatus: 'partial',
    shareToken
  });

  const payment = await Payment.create({
    business: business._id,
    customer: customer._id,
    invoice: invoice._id,
    salesDocument: invoice._id,
    amount: 100,
    method: 'upi',
    receivedAt: new Date()
  });

  await LedgerEntry.create({
    business: business._id,
    customer: customer._id,
    invoice: invoice._id,
    payment: payment._id,
    sourceType: 'payment',
    sourceId: payment._id,
    account: 'cash',
    direction: 'debit',
    amount: 100,
    description: `Receipt for ${customerName}`
  });

  return { ...context, customer, product, invoice, payment };
};

const fileMap = (files) => Object.fromEntries(files.map((file) => [file.name, file.content]));

// Minimal CSV reader: enough to count rows and read a quoted field back out.
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const body = text.startsWith(CSV_BOM) ? text.slice(CSV_BOM.length) : text;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && body[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
};

describe('data export - tenant isolation', () => {
  it('never includes another business data', async () => {
    const mine = await seedBusiness({ customerName: 'Alpha Traders', shareToken: crypto.randomUUID() });
    const theirs = await seedBusiness({ customerName: 'Zeta Rivals', shareToken: crypto.randomUUID() });

    const { files } = await buildExportFiles(mine.business._id);
    const everything = files.map((file) => file.content).join('\n');

    const foreignValues = [
      'Zeta Rivals',
      String(theirs.business._id),
      String(theirs.user._id),
      String(theirs.customer._id),
      String(theirs.product._id),
      String(theirs.invoice._id),
      String(theirs.payment._id),
      theirs.invoice.documentNumber,
      theirs.user.email
    ];

    foreignValues.forEach((value) => {
      assert.equal(everything.includes(value), false, `export leaked foreign value: ${value}`);
    });

    // Sanity: the export is not empty, so the assertions above are not vacuous.
    assert.equal(everything.includes('Alpha Traders'), true);
    assert.equal(everything.includes(String(mine.invoice._id)), true);
  });

  it('scopes every manifest entry to the business', async () => {
    const mine = await seedBusiness({ customerName: 'Alpha Traders', shareToken: crypto.randomUUID() });
    await seedBusiness({ customerName: 'Zeta Rivals', shareToken: crypto.randomUUID() });

    // Guards against a future entry being added with an unrecognised scope, which the
    // builder would silently treat as { business: id }.
    EXPORT_COLLECTIONS.forEach((entry) => {
      assert.ok(
        entry.scope === 'self' || entry.scope === undefined,
        `entry ${entry.name} uses an unknown scope: ${entry.scope}`
      );
    });

    const { counts } = await buildExportFiles(mine.business._id);
    assert.equal(counts.business, 1);
    assert.equal(counts.customers, 1);
    assert.equal(counts.products, 1);
    assert.equal(counts.invoices, 1);
    assert.equal(counts.invoice_items, 2);
    assert.equal(counts.payments, 1);
    assert.equal(counts.ledger_entries, 1);
    assert.equal(counts.team, 1);
  });
});

describe('data export - redaction', () => {
  it('omits share tokens, password hashes and pdf cache keys', async () => {
    const shareToken = crypto.randomUUID();
    const mine = await seedBusiness({ customerName: 'Alpha Traders', shareToken });
    await Invoice.updateOne({ _id: mine.invoice._id }, { $set: { pdfCacheKey: 'invoices/secret-cache-key.pdf' } });

    const withPassword = await User.findById(mine.user._id).select('+password');

    const { files } = await buildExportFiles(mine.business._id);
    const everything = files.map((file) => file.content).join('\n');

    assert.equal(everything.includes(shareToken), false, 'share token leaked');
    assert.equal(everything.includes('secret-cache-key'), false, 'pdf cache key leaked');
    assert.equal(everything.includes(withPassword.password), false, 'password hash leaked');
    assert.equal(everything.includes('$2b$'), false, 'a bcrypt hash leaked');
  });
});

describe('data export - csv', () => {
  it('escapes quotes, commas and newlines so the row count survives', () => {
    const nasty = 'Ravi "Bo", Ltd.\r\nSecond line';
    const csv = toCsv(
      [
        { name: nasty, total: 100 },
        { name: 'Plain', total: 5 }
      ],
      [
        { header: 'name', path: 'name' },
        { header: 'total', path: 'total' }
      ]
    );

    const rows = parseCsv(csv);
    assert.equal(rows.length, 3, 'header + 2 data rows');
    assert.deepEqual(rows[0], ['name', 'total']);
    assert.equal(rows[1][0], nasty);
    assert.equal(rows[1][1], '100');
    assert.equal(rows[2][0], 'Plain');
  });

  it('writes a header even when the collection is empty', async () => {
    const { business } = await createTestContext();
    const { files } = await buildExportFiles(business._id);

    const rows = parseCsv(fileMap(files)['csv/invoices.csv']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0][0], 'invoiceId');
  });

  it('exports the credit counters alongside the money columns', async () => {
    const mine = await seedBusiness({ customerName: 'Alpha Traders', shareToken: crypto.randomUUID() });
    // 40 of this invoice came from customer credit, and a note has claimed 60 of it.
    await Invoice.updateOne({ _id: mine.invoice._id }, { $set: { creditApplied: 40, creditedAmount: 60 } });

    const { files } = await buildExportFiles(mine.business._id);
    const rows = parseCsv(fileMap(files)['csv/invoices.csv']);
    const header = rows[0];
    const row = rows.find((entry) => entry[header.indexOf('invoiceId')] === String(mine.invoice._id));

    // Money and credit stay separate columns, exactly as they are separate fields.
    assert.equal(row[header.indexOf('paidAmount')], '100');
    assert.equal(row[header.indexOf('creditApplied')], '40');
    assert.equal(row[header.indexOf('creditedAmount')], '60');
    assert.ok(header.includes('appliedAmount'), 'a credit note reports how much of it was spent');
    assert.ok(header.includes('sourceInvoiceId'), 'a credit note names the invoice it credits');
  });

  it('flattens line items into their own sheet keyed to the parent', async () => {
    const mine = await seedBusiness({ customerName: 'Alpha Traders', shareToken: crypto.randomUUID() });
    const { files } = await buildExportFiles(mine.business._id);

    const rows = parseCsv(fileMap(files)['csv/invoice_items.csv']);
    const header = rows[0];
    assert.equal(rows.length, 3, 'header + 2 line items');
    rows.slice(1).forEach((row) => {
      assert.equal(row[header.indexOf('invoiceId')], String(mine.invoice._id));
      assert.equal(row[header.indexOf('documentNumber')], mine.invoice.documentNumber);
    });
  });
});

describe('data export - archive', () => {
  it('produces a zip containing every manifest file', async () => {
    const mine = await seedBusiness({ customerName: 'Alpha Traders', shareToken: crypto.randomUUID() });

    const { files } = await buildExportFiles(mine.business._id);
    const byName = fileMap(files);

    assert.ok(byName['manifest.json'], 'manifest.json missing');
    assert.ok(byName['README.txt'], 'README.txt missing');
    EXPORT_COLLECTIONS.forEach((entry) => {
      if (entry.csv) assert.ok(byName[`csv/${entry.name}.csv`], `csv/${entry.name}.csv missing`);
      if (entry.json !== false) assert.ok(byName[`json/${entry.name}.json`], `json/${entry.name}.json missing`);
    });

    const manifest = JSON.parse(byName['manifest.json']);
    assert.equal(manifest.business.id, String(mine.business._id));
    assert.equal(manifest.counts.invoices, 1);
    assert.equal(manifest.files.length, files.length - 2, 'manifest lists every data file');

    // json/ must stay parseable - it is the re-import path.
    assert.equal(JSON.parse(byName['json/invoices.json']).length, 1);
    assert.equal(JSON.parse(byName['json/customers.json'])[0].name, 'Alpha Traders');

    const { buffer, counts } = await buildExportArchive(mine.business._id);
    // Zip local file header magic.
    assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'not a zip');
    assert.equal(counts.invoices, 1);
  });
});

describe('data export - api', () => {
  it('queues an export for an owner and refuses a second one while it is in flight', async () => {
    const { token } = await createTestContext();

    const first = await request(app).post('/api/exports').set(authHeader(token));
    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'queued');
    assert.equal(first.body.sizeBytes, 0);
    // Nothing emailed yet — the UI keys its "Emailed to you" line off this.
    assert.equal(first.body.emailedAt, null);
    // The download token and object key must never reach the client.
    assert.equal(first.body.tokenHash, undefined);
    assert.equal(first.body.objectKey, undefined);

    const second = await request(app).post('/api/exports').set(authHeader(token));
    assert.equal(second.status, 429);
    assert.equal(second.body.details.code, 'EXPORT_IN_PROGRESS');

    const list = await request(app).get('/api/exports').set(authHeader(token));
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, first.body.id);
  });

  it('enforces the one-per-hour cooldown after a completed export', async () => {
    const { business, user, token } = await createTestContext();
    await DataExport.create({
      business: business._id,
      requestedBy: user._id,
      status: 'completed',
      completedAt: new Date(),
      objectKey: `exports/${business._id}/old.zip`,
      expiresAt: new Date(Date.now() + 86_400_000)
    });

    const response = await request(app).post('/api/exports').set(authHeader(token));
    assert.equal(response.status, 429);
    assert.equal(response.body.details.code, 'EXPORT_COOLDOWN');
  });

  it('denies roles without settings.export', async () => {
    const viewer = await createTestContext({ roleKey: 'viewer' });
    const staff = await createTestContext({ roleKey: 'staff' });
    const accountant = await createTestContext({ roleKey: 'accountant' });

    for (const context of [viewer, staff, accountant]) {
      const created = await request(app).post('/api/exports').set(authHeader(context.token));
      assert.equal(created.status, 403, `role ${context.membership.roleKey} could request an export`);

      const listed = await request(app).get('/api/exports').set(authHeader(context.token));
      assert.equal(listed.status, 403, `role ${context.membership.roleKey} could list exports`);
    }
  });

  it('requires authentication', async () => {
    const response = await request(app).get('/api/exports');
    assert.equal(response.status, 401);
  });

  it('will not hand out a download for an export that is not finished', async () => {
    const { business, user, token } = await createTestContext();
    const row = await DataExport.create({ business: business._id, requestedBy: user._id, status: 'queued' });

    const response = await request(app).get(`/api/exports/${row._id}/download-url`).set(authHeader(token));
    assert.equal(response.status, 409);
  });

  it('will not serve another business export', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();
    const row = await DataExport.create({
      business: theirs.business._id,
      requestedBy: theirs.user._id,
      status: 'completed',
      objectKey: `exports/${theirs.business._id}/${theirs.business._id}.zip`,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000)
    });

    const response = await request(app).get(`/api/exports/${row._id}`).set(authHeader(mine.token));
    assert.equal(response.status, 404);

    const download = await request(app).get(`/api/exports/${row._id}/download-url`).set(authHeader(mine.token));
    assert.equal(download.status, 404);
  });

  it('enqueues an outbox event the dispatcher routes to the export job', async () => {
    const { business, token } = await createTestContext();
    const created = await request(app).post('/api/exports').set(authHeader(token));
    assert.equal(created.status, 202);

    const event = await OutboxEvent.findOne({ business: business._id, eventType: DOMAIN_EVENTS.dataExportRequested });
    assert.ok(event, 'no outbox event was published for the export');
    assert.equal(String(event.aggregateId), created.body.id);
    assert.equal(event.status, 'pending');

    // Exercises the dispatcher branch itself. A vanished export is a no-op rather than a
    // throw, so a deleted row cannot wedge the outbox in a retry loop.
    await dispatchOutboxEvent({
      ...event.toObject(),
      aggregateId: new mongoose.Types.ObjectId()
    });
  });

  it('rejects an emailed link with a wrong or expired token', async () => {
    const { business, user } = await createTestContext();
    const row = await DataExport.create({
      business: business._id,
      requestedBy: user._id,
      status: 'completed',
      objectKey: `exports/${business._id}/${business._id}.zip`,
      tokenHash: crypto.createHash('sha256').update('the-real-token').digest('hex'),
      completedAt: new Date(),
      expiresAt: new Date(Date.now() - 1000)
    });

    const wrongToken = await request(app).get(`/api/public/exports/${row._id}/not-the-token`);
    assert.equal(wrongToken.status, 404);

    // Right token, but the archive is past its retention window.
    const expired = await request(app).get(`/api/public/exports/${row._id}/the-real-token`);
    assert.equal(expired.status, 410);
  });
});
