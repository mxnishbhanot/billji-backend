import Notification from '../models/Notification.js';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import { DOMAIN_EVENTS } from './eventBus.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const formatDate = (value) =>
  new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(new Date(value));

const formatMoney = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0));

const priorityForTone = (tone) => {
  if (tone === 'danger') return 1;
  if (tone === 'warning') return 2;
  return 3;
};

const idFor = (type, resourceId) => `${type}:${resourceId}`.slice(0, 180);

export const serializeNotification = (notification, state = null) => ({
  id: notification.notificationId,
  type: notification.type,
  resourceType: notification.resourceType,
  resourceId: notification.resourceId?.toString?.() || '',
  tone: notification.tone,
  title: notification.title,
  description: notification.description,
  to: notification.to,
  sortDate: notification.sortDate || notification.createdAt,
  read: Boolean(state?.readAt)
});

export const upsertNotification = async ({
  business,
  actor = null,
  notificationId,
  type,
  resourceType,
  resourceId = null,
  tone = 'info',
  title,
  description = '',
  to = '',
  sortDate = new Date(),
  sourceEvent = null,
  metadata = {}
}) =>
  Notification.findOneAndUpdate(
    { business, notificationId },
    {
      $set: {
        actor,
        type,
        resourceType,
        resourceId,
        tone,
        title,
        description,
        to,
        sortDate,
        priority: priorityForTone(tone),
        sourceEvent,
        metadata,
        resolvedAt: null
      },
      $setOnInsert: { business, notificationId }
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

const resolveNotifications = (business, filters) =>
  Notification.updateMany({ business, resolvedAt: null, ...filters }, { $set: { resolvedAt: new Date() } });

export const resolveInvoiceReminderNotifications = (business, invoiceId) =>
  resolveNotifications(business, {
    resourceType: 'invoice',
    resourceId: invoiceId,
    type: { $in: ['overdue-invoice', 'due-soon-invoice', 'old-pending-invoice'] }
  });

export const resolveStockNotifications = (business, productId) =>
  resolveNotifications(business, {
    resourceType: 'product',
    resourceId: productId,
    type: { $in: ['negative-stock', 'low-stock'] }
  });

const productNotification = ({ business, product, type, tone, title, description, sourceEvent = null, actor = null }) =>
  upsertNotification({
    business,
    actor,
    notificationId: idFor(type, product._id),
    type,
    resourceType: 'product',
    resourceId: product._id,
    tone,
    title,
    description,
    to: `/products?highlight=${product._id}`,
    sortDate: product.updatedAt || product.createdAt || new Date(),
    sourceEvent,
    metadata: {
      stockQuantity: product.stockQuantity,
      lowStockThreshold: product.lowStockThreshold
    }
  });

const invoiceNotification = ({ business, invoice, type, tone, title, description, sortDate, sourceEvent = null, actor = null, metadata = {} }) =>
  upsertNotification({
    business,
    actor,
    notificationId: idFor(type, invoice._id),
    type,
    resourceType: 'invoice',
    resourceId: invoice._id,
    tone,
    title,
    description,
    to: `/invoices/${invoice._id}`,
    sortDate: sortDate || invoice.dueDate || invoice.updatedAt || invoice.createdAt || invoice.date || new Date(),
    sourceEvent,
    metadata
  });

const projectStockNotification = async (event) => {
  const productId = event.payload.productId || event.aggregateId;
  if (!productId) return;

  const product = await Product.findOne({ _id: productId, business: event.business }).lean();
  if (!product || product.trackStock === false) {
    await resolveStockNotifications(event.business, productId);
    return;
  }

  if (Number(product.stockQuantity || 0) < 0) {
    await productNotification({
      business: event.business,
      actor: event.actor,
      sourceEvent: event._id,
      type: 'negative-stock',
      product,
      tone: 'danger',
      title: `${product.name} is below zero stock`,
      description: `${Math.abs(Number(product.stockQuantity || 0))} item${Math.abs(Number(product.stockQuantity || 0)) === 1 ? '' : 's'} oversold. Update stock after the force sale.`
    });
    return;
  }

  if (Number(product.stockQuantity || 0) <= Number(product.lowStockThreshold || 0)) {
    await productNotification({
      business: event.business,
      actor: event.actor,
      sourceEvent: event._id,
      type: 'low-stock',
      product,
      tone: 'warning',
      title: `${product.name} is low on stock`,
      description: `${product.stockQuantity} left. Alert threshold is ${product.lowStockThreshold}.`
    });
    return;
  }

  await resolveStockNotifications(event.business, productId);
};

const MATERIALIZE_THROTTLE_MS = 60 * 1000;
const lastMaterializeAt = new Map();

export const materializeReminderNotifications = async (business, { force = false } = {}) => {
  const key = String(business);
  if (!force) {
    const last = lastMaterializeAt.get(key);
    if (last && Date.now() - last < MATERIALIZE_THROTTLE_MS) {
      return;
    }
  }
  lastMaterializeAt.set(key, Date.now());

  const today = startOfDay();
  const soonLimit = new Date(today.getTime() + 3 * DAY_MS);
  const oldPendingLimit = new Date(today.getTime() - 7 * DAY_MS);

  const [negativeStock, lowStock, overdueInvoices, dueSoonInvoices, oldPendingInvoices] = await Promise.all([
    Product.find({ business, trackStock: { $ne: false }, stockQuantity: { $lt: 0 } }).limit(100).lean(),
    Product.find({
      business,
      trackStock: { $ne: false },
      stockQuantity: { $gte: 0 },
      $expr: { $lte: ['$stockQuantity', '$lowStockThreshold'] }
    }).limit(100).lean(),
    Invoice.find({ business, documentType: 'invoice', documentStatus: 'issued', paymentStatus: { $in: ['unpaid', 'partial'] }, dueDate: { $lt: today } })
      .sort({ dueDate: 1 })
      .limit(100)
      .lean(),
    Invoice.find({ business, documentType: 'invoice', documentStatus: 'issued', paymentStatus: { $in: ['unpaid', 'partial'] }, dueDate: { $gte: today, $lte: soonLimit } })
      .sort({ dueDate: 1 })
      .limit(100)
      .lean(),
    Invoice.find({ business, documentType: 'invoice', documentStatus: 'issued', paymentStatus: { $in: ['unpaid', 'partial'] }, dueDate: null, createdAt: { $lte: oldPendingLimit } })
      .sort({ createdAt: 1 })
      .limit(100)
      .lean()
  ]);

  await Promise.all([
    ...negativeStock.map((product) =>
      productNotification({
        business,
        type: 'negative-stock',
        product,
        tone: 'danger',
        title: `${product.name} is below zero stock`,
        description: `${Math.abs(Number(product.stockQuantity || 0))} item${Math.abs(Number(product.stockQuantity || 0)) === 1 ? '' : 's'} oversold. Update stock after the force sale.`
      })
    ),
    ...lowStock.map((product) =>
      productNotification({
        business,
        type: 'low-stock',
        product,
        tone: 'warning',
        title: `${product.name} is low on stock`,
        description: `${product.stockQuantity} left. Alert threshold is ${product.lowStockThreshold}.`
      })
    ),
    ...overdueInvoices.map((invoice) =>
      invoiceNotification({
        business,
        type: 'overdue-invoice',
        invoice,
        tone: 'danger',
        title: `${invoice.invoiceNumber} is overdue`,
        description: `${invoice.customerSnapshot.name} payment was due on ${formatDate(invoice.dueDate)}.`,
        sortDate: invoice.dueDate
      })
    ),
    ...dueSoonInvoices.map((invoice) =>
      invoiceNotification({
        business,
        type: 'due-soon-invoice',
        invoice,
        tone: 'warning',
        title: `${invoice.invoiceNumber} is due soon`,
        description: `${invoice.customerSnapshot.name} payment is due on ${formatDate(invoice.dueDate)}.`,
        sortDate: invoice.dueDate
      })
    ),
    ...oldPendingInvoices.map((invoice) =>
      invoiceNotification({
        business,
        type: 'old-pending-invoice',
        invoice,
        tone: 'info',
        title: `${invoice.invoiceNumber} needs follow-up`,
        description: `${invoice.customerSnapshot.name} has been pending since ${formatDate(invoice.createdAt || invoice.date)}.`,
        sortDate: invoice.createdAt || invoice.date
      })
    )
  ]);
};

export const projectNotificationsForEvent = async (event) => {
  if (event.eventType === DOMAIN_EVENTS.stockAdjusted) {
    await projectStockNotification(event);
    return;
  }

  if (event.eventType === DOMAIN_EVENTS.documentIssued) {
    const invoice = { _id: event.aggregateId, ...event.payload };
    await invoiceNotification({
      business: event.business,
      actor: event.actor,
      sourceEvent: event._id,
      type: 'invoice-created',
      invoice,
      tone: 'info',
      title: `${event.payload.documentNumber || event.payload.invoiceNumber || 'Invoice'} was created`,
      description: `${event.payload.customerName || 'Customer'} · ${formatMoney(event.payload.total, event.payload.currency || 'INR')}.`,
      sortDate: event.createdAt,
      metadata: event.payload
    });
    return;
  }

  if (event.eventType === DOMAIN_EVENTS.documentCancelled) {
    await resolveInvoiceReminderNotifications(event.business, event.aggregateId);
    const invoice = { _id: event.aggregateId, ...event.payload };
    await invoiceNotification({
      business: event.business,
      actor: event.actor,
      sourceEvent: event._id,
      type: 'invoice-cancelled',
      invoice,
      tone: 'warning',
      title: `${event.payload.documentNumber || event.payload.invoiceNumber || 'Invoice'} was cancelled`,
      description: `${event.payload.customerName || 'Customer'} invoice is no longer active.`,
      sortDate: event.createdAt,
      metadata: event.payload
    });
    return;
  }

  if (event.eventType === DOMAIN_EVENTS.paymentRecorded) {
    await resolveInvoiceReminderNotifications(event.business, event.payload.invoiceId || event.aggregateId);
    const invoice = { _id: event.payload.invoiceId || event.aggregateId, ...event.payload };
    await invoiceNotification({
      business: event.business,
      actor: event.actor,
      sourceEvent: event._id,
      type: 'payment-received',
      invoice,
      tone: 'info',
      title: `Payment received for ${event.payload.invoiceNumber || 'invoice'}`,
      description: `${formatMoney(event.payload.amount, event.payload.currency || 'INR')} via ${event.payload.method || 'payment'}.`,
      sortDate: event.payload.receivedAt || event.createdAt,
      metadata: event.payload
    });
    return;
  }

  if (event.eventType === DOMAIN_EVENTS.documentShared) {
    const invoice = { _id: event.aggregateId, ...event.payload };
    await invoiceNotification({
      business: event.business,
      actor: event.actor,
      sourceEvent: event._id,
      type: 'document-shared',
      invoice,
      tone: 'info',
      title: `${event.payload.documentNumber || event.payload.invoiceNumber || 'Invoice'} was shared`,
      description: event.payload.recipient ? `Sent to ${event.payload.recipient}.` : 'Share link was generated.',
      sortDate: event.createdAt,
      metadata: event.payload
    });
    return;
  }

  if (event.eventType === DOMAIN_EVENTS.customerCreated) {
    await upsertNotification({
      business: event.business,
      actor: event.actor,
      notificationId: idFor('staff-activity', event.aggregateId),
      type: 'staff-activity',
      resourceType: 'customer',
      resourceId: event.aggregateId,
      tone: 'info',
      title: `${event.payload.customerName || 'Customer'} was added`,
      description: event.payload.actorName ? `${event.payload.actorName} added a customer profile.` : 'Customer profile was added.',
      to: `/customers/${event.aggregateId}`,
      sortDate: event.createdAt,
      sourceEvent: event._id,
      metadata: event.payload
    });
  }
};
