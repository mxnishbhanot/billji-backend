import crypto from 'crypto';
import request from 'supertest';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import app from '../src/app.js';
import Business from '../src/models/Business.js';
import Invoice from '../src/models/Invoice.js';
import Notification from '../src/models/Notification.js';
import {
  DEFAULT_REMINDER_TEMPLATE,
  listPendingReminders,
  renderReminderMessage,
  runReminderMaterialization
} from '../src/services/reminderService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';

useMongoTestDb();

const api = () => request(app);
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

let seq = 0;
const createInvoice = (business, overrides = {}) => {
  seq += 1;
  const total = overrides.total ?? 1000;
  return Invoice.create({
    business: business._id,
    documentType: 'invoice',
    documentNumber: `REM-${String(seq).padStart(4, '0')}`,
    invoiceNumber: `REM-${String(seq).padStart(4, '0')}`,
    customerSnapshot: { name: 'Ramesh Kumar', phone: '9876543210', countryCode: '+91' },
    items: [{ name: 'Rice', quantity: 1, price: total, total }],
    subtotal: total,
    total,
    paidAmount: 0,
    balanceDue: total,
    documentStatus: 'issued',
    paymentStatus: 'unpaid',
    date: daysAgo(40),
    dueDate: daysAgo(20),
    shareToken: crypto.randomBytes(12).toString('hex'),
    shareExpiresAt: daysAgo(5),
    ...overrides
  });
};

describe('reminder message template', () => {
  it('fills every token and formats the amount as rupees', () => {
    const message = renderReminderMessage({
      template: '{business}: {name} owes {amount} on {invoice} ({days} days). Pay: {link}',
      name: 'Ramesh',
      invoiceNumber: 'INV-0007',
      amount: 12000,
      link: 'https://billji.test/x.pdf',
      businessName: 'Sharma Traders',
      days: 18
    });

    assert.match(message, /^Sharma Traders: Ramesh owes /);
    assert.match(message, /12,000/);
    assert.match(message, /INV-0007 \(18 days\)/);
    assert.match(message, /https:\/\/billji\.test\/x\.pdf$/);
  });

  it('falls back to the built-in copy and leaves unknown tokens visible', () => {
    assert.match(renderReminderMessage({ name: 'A', invoiceNumber: 'B', amount: 1, link: 'C' }), /friendly reminder/);
    assert.match(renderReminderMessage({ template: 'Hi {name} {oops}', name: 'A' }), /\{oops\}/);
  });
});

describe('pending reminder list', () => {
  it('includes overdue and aged no-due-date invoices, biggest debt first', async () => {
    const { business } = await createTestContext();

    await createInvoice(business, { total: 500 });
    await createInvoice(business, { total: 9000 });
    // No due date but older than the 7-day ageing rule.
    await createInvoice(business, { total: 2000, dueDate: null, createdAt: daysAgo(30) });

    const { reminders, totalOutstanding } = await listPendingReminders(business._id);

    assert.equal(reminders.length, 3);
    assert.deepEqual(reminders.map((row) => row.balanceDue), [9000, 2000, 500]);
    assert.equal(totalOutstanding, 11500);
    assert.equal(reminders.find((row) => row.balanceDue === 2000).reason, 'pending');
    assert.equal(reminders[0].reason, 'overdue');
    assert.ok(reminders[0].daysOverdue >= 20);
  });

  it('leaves out paid, cancelled, not-yet-due, revoked and phoneless invoices', async () => {
    const { business } = await createTestContext();

    await createInvoice(business, { paymentStatus: 'paid', paidAmount: 1000, balanceDue: 0 });
    await createInvoice(business, { documentStatus: 'cancelled' });
    await createInvoice(business, { dueDate: new Date(Date.now() + 5 * DAY_MS) });
    await createInvoice(business, { shareRevokedAt: new Date() });
    // Recent, no due date — not yet old enough to chase.
    await createInvoice(business, { dueDate: null, createdAt: daysAgo(2) });
    // customerSnapshot.phone is required by the schema, so a phoneless invoice can only
    // come from a legacy/imported row. Insert one raw to prove the guard still holds.
    await Invoice.collection.insertOne({
      business: business._id,
      documentType: 'invoice',
      documentNumber: 'REM-LEGACY',
      invoiceNumber: 'REM-LEGACY',
      customerSnapshot: { name: 'Walk-in' },
      items: [{ name: 'Rice', quantity: 1, price: 100, total: 100 }],
      subtotal: 100,
      total: 100,
      balanceDue: 100,
      documentStatus: 'issued',
      paymentStatus: 'unpaid',
      dueDate: daysAgo(15),
      shareToken: crypto.randomBytes(12).toString('hex'),
      shareRevokedAt: null,
      createdAt: daysAgo(30)
    });

    const { reminders, skippedWithoutPhone } = await listPendingReminders(business._id);

    assert.equal(reminders.length, 0);
    assert.equal(skippedWithoutPhone, 1);
  });

  it('counts only the unpaid balance of a part-paid invoice', async () => {
    const { business } = await createTestContext();
    await createInvoice(business, { total: 1000, paidAmount: 400, balanceDue: 600, paymentStatus: 'partial' });

    const { reminders } = await listPendingReminders(business._id);

    assert.equal(reminders[0].balanceDue, 600);
  });

  it('never leaks another business\'s invoices', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();
    await createInvoice(theirs.business, { total: 7777 });

    const { reminders } = await listPendingReminders(mine.business._id);

    assert.equal(reminders.length, 0);
  });
});

describe('reminder send API', () => {
  it('prepares WhatsApp links and revives share links that had already expired', async () => {
    const { business, token } = await createTestContext();
    await Business.updateOne({ _id: business._id }, { $set: { reminderTemplate: 'Pay {amount} for {invoice}' } });
    const invoice = await createInvoice(business, { total: 3200 });

    const res = await api()
      .post('/api/v1/invoices/reminders/send')
      .set(authHeader(token))
      .send({ invoiceIds: [invoice._id.toString()] })
      .expect(200);

    assert.equal(res.body.prepared, 1);
    const [reminder] = res.body.reminders;
    assert.match(reminder.whatsappUrl, /^https:\/\/wa\.me\/919876543210\?text=/);
    assert.match(decodeURIComponent(reminder.whatsappUrl), /Pay .*3,200.* for REM-/);
    assert.ok(reminder.pdfUrl.includes(invoice.shareToken));

    // The 5-day-expired share link is pushed back out so the message is usable.
    const refreshed = await Invoice.findById(invoice._id).lean();
    assert.ok(refreshed.shareExpiresAt.getTime() > Date.now() + 20 * DAY_MS);
  });

  it('refuses an empty selection and ignores invoices outside the business', async () => {
    const mine = await createTestContext();
    const theirs = await createTestContext();
    const foreign = await createInvoice(theirs.business);

    await api().post('/api/v1/invoices/reminders/send').set(authHeader(mine.token)).send({ invoiceIds: [] }).expect(422);

    const res = await api()
      .post('/api/v1/invoices/reminders/send')
      .set(authHeader(mine.token))
      .send({ invoiceIds: [foreign._id.toString()] })
      .expect(200);

    assert.equal(res.body.requested, 1);
    assert.equal(res.body.prepared, 0);
    // And the other business's share link was not touched.
    const untouched = await Invoice.findById(foreign._id).lean();
    assert.ok(untouched.shareExpiresAt.getTime() < Date.now());
  });

  it('serves the list with the business template over HTTP', async () => {
    const { business, token } = await createTestContext();
    await createInvoice(business, { total: 4500 });

    const res = await api().get('/api/v1/invoices/reminders/pending').set(authHeader(token)).expect(200);

    assert.equal(res.body.reminders.length, 1);
    assert.equal(res.body.totalOutstanding, 4500);
    assert.equal(res.body.template, DEFAULT_REMINDER_TEMPLATE);
  });
});

describe('hourly reminder materialization', () => {
  it('creates overdue notifications without anyone opening the app, and is idempotent', async () => {
    const { business } = await createTestContext();
    await createInvoice(business, { total: 1500 });

    assert.equal(await runReminderMaterialization(), 1);
    const afterFirst = await Notification.find({ business: business._id, type: 'overdue-invoice' }).lean();
    assert.equal(afterFirst.length, 1);

    // Second sweep upserts the same row rather than piling up duplicates.
    await runReminderMaterialization();
    const afterSecond = await Notification.find({ business: business._id, type: 'overdue-invoice' }).lean();
    assert.equal(afterSecond.length, 1);
    assert.equal(String(afterSecond[0]._id), String(afterFirst[0]._id));
  });

  it('skips suspended businesses', async () => {
    const { business } = await createTestContext();
    await createInvoice(business, { total: 1500 });
    await Business.updateOne({ _id: business._id }, { $set: { status: 'suspended' } });

    assert.equal(await runReminderMaterialization(), 0);
    assert.equal(await Notification.countDocuments({ business: business._id, type: 'overdue-invoice' }), 0);
  });
});
