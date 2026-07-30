import Business from '../models/Business.js';
import Invoice from '../models/Invoice.js';
import { ApiError } from '../utils/ApiError.js';
import { DOMAIN_EVENTS, publishDomainEvent } from './eventBus.js';
import { resolveShareablePdfUrl } from './invoiceService.js';
import { materializeReminderNotifications } from './notificationService.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Invoices with no due date are only worth chasing once they have aged; matches the
// 'old-pending-invoice' rule in notificationService so the bell and this list agree.
const OLD_PENDING_DAYS = 7;
const SHARE_LINK_TTL_MS = 30 * DAY_MS;
// A reminder should not go out with a link that dies tomorrow.
const SHARE_LINK_MIN_REMAINING_MS = 7 * DAY_MS;
const MAX_REMINDERS_PER_SEND = 50;

export const DEFAULT_REMINDER_TEMPLATE =
  'Hello {name}, a friendly reminder that invoice {invoice} for {amount} is still pending. You can view it here: {link}';

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const formatMoney = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0));

const daysBetween = (from, to = new Date()) => Math.max(Math.floor((startOfDay(to) - startOfDay(from)) / DAY_MS), 0);

/**
 * Fills the business's reminder template. Unknown tokens are left alone rather than
 * blanked, so a typo shows up in the preview instead of silently vanishing.
 */
export const renderReminderMessage = ({ template, name, invoiceNumber, amount, link, businessName, days }) => {
  const values = {
    name: name || 'there',
    invoice: invoiceNumber || '',
    amount: formatMoney(amount),
    link: link || '',
    business: businessName || '',
    days: String(days ?? 0)
  };

  return String(template || DEFAULT_REMINDER_TEMPLATE).replace(/\{(name|invoice|amount|link|business|days)\}/g, (_match, token) => values[token]);
};

const pendingReminderFilter = (businessId, today) => ({
  business: businessId,
  documentType: 'invoice',
  documentStatus: 'issued',
  paymentStatus: { $in: ['unpaid', 'partial'] },
  // A revoked link means the owner deliberately cut off access — never re-share it.
  shareRevokedAt: null,
  $or: [
    { dueDate: { $lt: today } },
    { dueDate: null, createdAt: { $lte: new Date(today.getTime() - OLD_PENDING_DAYS * DAY_MS) } }
  ]
});

const reminderRow = (invoice, today) => {
  const dueDate = invoice.dueDate || null;
  const balance = Number(invoice.balanceDue ?? Math.max(Number(invoice.total || 0) - Number(invoice.paidAmount || 0), 0));

  return {
    invoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber || invoice.documentNumber,
    customerId: invoice.customer ? String(invoice.customer) : null,
    customerName: invoice.customerSnapshot?.name || 'Customer',
    phone: invoice.customerSnapshot?.phone || '',
    countryCode: invoice.customerSnapshot?.countryCode || '+91',
    total: Number(invoice.total || 0),
    balanceDue: balance,
    dueDate,
    daysOverdue: daysBetween(dueDate || invoice.createdAt || invoice.date, today),
    reason: dueDate ? 'overdue' : 'pending'
  };
};

/**
 * Everything worth chasing today, biggest debt first. Read-only: no links are minted
 * and nothing is marked as sent — that happens in sendReminders.
 */
export const listPendingReminders = async (businessId, { limit = 200 } = {}) => {
  const today = startOfDay();
  const invoices = await Invoice.find(pendingReminderFilter(businessId, today))
    .sort({ dueDate: 1, createdAt: 1 })
    .limit(limit)
    .lean();

  const rows = invoices.map((invoice) => reminderRow(invoice, today)).filter((row) => Boolean(row.phone));

  return {
    reminders: rows.sort((a, b) => b.balanceDue - a.balanceDue),
    totalOutstanding: Math.round(rows.reduce((sum, row) => sum + row.balanceDue, 0) * 100) / 100,
    // Invoices we cannot chase, so the UI can say why the counts differ.
    skippedWithoutPhone: invoices.length - rows.length
  };
};

/**
 * Prepares WhatsApp messages for the chosen invoices.
 *
 * Extends any share link that is expired or about to expire — an overdue invoice is old
 * by definition, and the default 30-day share window has usually lapsed by the time it is
 * worth chasing. Without this the reminder would carry a dead link.
 *
 * The share event is recorded here rather than after the fact: with the device share sheet
 * the app never learns whether the user actually pressed send in WhatsApp, so "prepared and
 * handed to WhatsApp" is the only truth available. The activity log wording reflects that.
 */
export const sendReminders = async ({ req, invoiceIds }) => {
  const ids = [...new Set((Array.isArray(invoiceIds) ? invoiceIds : []).map(String))];

  if (!ids.length) {
    throw new ApiError(422, 'Select at least one invoice to remind');
  }
  if (ids.length > MAX_REMINDERS_PER_SEND) {
    throw new ApiError(422, `You can send at most ${MAX_REMINDERS_PER_SEND} reminders at a time`);
  }

  const businessId = req.business._id;
  const today = startOfDay();
  const now = new Date();

  await Invoice.updateMany(
    {
      business: businessId,
      _id: { $in: ids },
      shareRevokedAt: null,
      $or: [{ shareExpiresAt: null }, { shareExpiresAt: { $lt: new Date(now.getTime() + SHARE_LINK_MIN_REMAINING_MS) } }]
    },
    { $set: { shareExpiresAt: new Date(now.getTime() + SHARE_LINK_TTL_MS) } }
  );

  const invoices = await Invoice.find({ ...pendingReminderFilter(businessId, today), _id: { $in: ids } });
  const template = req.business.reminderTemplate || DEFAULT_REMINDER_TEMPLATE;
  const reminders = [];

  for (const invoice of invoices) {
    const row = reminderRow(invoice, today);
    if (!row.phone) continue;

    const pdfUrl = await resolveShareablePdfUrl(invoice, req);
    const message = renderReminderMessage({
      template,
      name: row.customerName,
      invoiceNumber: row.invoiceNumber,
      amount: row.balanceDue,
      link: pdfUrl,
      businessName: req.business.businessName,
      days: row.daysOverdue
    });

    const phoneDigits = `${row.countryCode}${row.phone}`.replace(/[^\d]/g, '');
    reminders.push({
      ...row,
      message,
      pdfUrl,
      whatsappUrl: `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`
    });

    await publishDomainEvent({
      business: businessId,
      actor: req.user._id,
      eventType: DOMAIN_EVENTS.documentShared,
      aggregateType: 'sales_document',
      aggregateId: invoice._id,
      payload: {
        documentType: invoice.documentType || 'invoice',
        documentNumber: invoice.documentNumber || invoice.invoiceNumber,
        invoiceNumber: invoice.invoiceNumber,
        customerId: invoice.customer,
        customerName: row.customerName,
        recipient: `${row.countryCode} ${row.phone}`,
        channel: 'whatsapp',
        reason: 'payment_reminder'
      },
      dedupeKey: `${DOMAIN_EVENTS.documentShared}:${invoice._id}:reminder:${now.toISOString().slice(0, 10)}`
    });
  }

  return { reminders, requested: ids.length, prepared: reminders.length };
};

/**
 * Hourly job: keeps every active business's reminder notifications current without
 * waiting for someone to open the app.
 *
 * ponytail: sequential loop capped at 500 businesses per tick. Fine while the whole
 * customer base fits comfortably inside one hourly run; shard by business id or move to
 * a queue when it does not.
 */
export const runReminderMaterialization = async ({ limit = 500 } = {}) => {
  const businesses = await Business.find({ status: 'active' }).select('_id').limit(limit).lean();

  let processed = 0;
  for (const business of businesses) {
    try {
      await materializeReminderNotifications(business._id, { force: true });
      processed += 1;
    } catch (error) {
      // One bad business must not stop the sweep.
      console.error(`Reminder materialization failed for business ${business._id}:`, error.message);
    }
  }

  return processed;
};
