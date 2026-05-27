import NotificationRead from '../models/NotificationRead.js';
import Invoice from '../models/Invoice.js';
import Product from '../models/Product.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, paginationMeta } from '../utils/pagination.js';

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

const notificationId = (type, item) => {
  const stamp = new Date(item.updatedAt || item.createdAt || item.date || Date.now()).getTime();
  return `${type}:${item._id}:${stamp}`;
};
const priorityForTone = (tone) => {
  if (tone === 'danger') return 1;
  if (tone === 'warning') return 2;
  return 3;
};

const productNotification = ({ type, product, tone, title, description }) => ({
  id: notificationId(type, product),
  type,
  resourceType: 'product',
  resourceId: product._id,
  tone,
  title,
  description,
  to: `/products?highlight=${product._id}`,
  sortDate: product.updatedAt || product.createdAt,
  priority: priorityForTone(tone)
});

const invoiceNotification = ({ type, invoice, tone, title, description }) => ({
  id: notificationId(type, invoice),
  type,
  resourceType: 'invoice',
  resourceId: invoice._id,
  tone,
  title,
  description,
  to: `/invoices/${invoice._id}`,
  sortDate: invoice.dueDate || invoice.updatedAt || invoice.createdAt || invoice.date,
  priority: priorityForTone(tone)
});

const notificationFilters = (userId) => {
  const today = startOfDay();
  const soonLimit = new Date(today.getTime() + 3 * DAY_MS);
  const oldPendingLimit = new Date(today.getTime() - 7 * DAY_MS);
  const recentActivityLimit = new Date(today.getTime() - 7 * DAY_MS);

  return {
    negativeStock: { user: userId, stockQuantity: { $lt: 0 } },
    lowStock: {
      user: userId,
      stockQuantity: { $gte: 0 },
      $expr: { $lte: ['$stockQuantity', '$lowStockThreshold'] }
    },
    overdueInvoices: { user: userId, status: 'pending', dueDate: { $lt: today } },
    dueSoonInvoices: { user: userId, status: 'pending', dueDate: { $gte: today, $lte: soonLimit } },
    oldPendingInvoices: { user: userId, status: 'pending', dueDate: null, createdAt: { $lte: oldPendingLimit } },
    recentInvoices: { user: userId, status: { $ne: 'cancelled' }, createdAt: { $gte: recentActivityLimit } }
  };
};

const sortNotifications = (notifications) =>
  notifications.sort((a, b) => a.priority - b.priority || new Date(b.sortDate || 0) - new Date(a.sortDate || 0));

const buildNotifications = async (userId, fetchLimit) => {
  if (fetchLimit <= 0) {
    return [];
  }

  const filters = notificationFilters(userId);
  const [negativeStock, lowStock, overdueInvoices, dueSoonInvoices, oldPendingInvoices, recentInvoices] = await Promise.all([
    Product.find(filters.negativeStock).sort({ updatedAt: -1 }).limit(fetchLimit).lean(),
    Product.find(filters.lowStock).sort({ updatedAt: -1 }).limit(fetchLimit).lean(),
    Invoice.find(filters.overdueInvoices).sort({ dueDate: 1, updatedAt: -1 }).limit(fetchLimit).lean(),
    Invoice.find(filters.dueSoonInvoices).sort({ dueDate: 1, updatedAt: -1 }).limit(fetchLimit).lean(),
    Invoice.find(filters.oldPendingInvoices).sort({ createdAt: 1 }).limit(fetchLimit).lean(),
    Invoice.find(filters.recentInvoices).sort({ createdAt: -1 }).limit(fetchLimit).lean()
  ]);

  return sortNotifications([
    ...negativeStock.map((product) =>
      productNotification({
        type: 'negative-stock',
        product,
        tone: 'danger',
        title: `${product.name} is below zero stock`,
        description: `${Math.abs(Number(product.stockQuantity || 0))} item${Math.abs(Number(product.stockQuantity || 0)) === 1 ? '' : 's'} oversold. Update stock after the force sale.`
      })
    ),
    ...lowStock.map((product) =>
      productNotification({
        type: 'low-stock',
        product,
        tone: 'warning',
        title: `${product.name} is low on stock`,
        description: `${product.stockQuantity} left. Alert threshold is ${product.lowStockThreshold}.`
      })
    ),
    ...overdueInvoices.map((invoice) =>
      invoiceNotification({
        type: 'overdue-invoice',
        invoice,
        tone: 'danger',
        title: `${invoice.invoiceNumber} is overdue`,
        description: `${invoice.customerSnapshot.name} payment was due on ${formatDate(invoice.dueDate)}.`
      })
    ),
    ...dueSoonInvoices.map((invoice) =>
      invoiceNotification({
        type: 'due-soon-invoice',
        invoice,
        tone: 'warning',
        title: `${invoice.invoiceNumber} is due soon`,
        description: `${invoice.customerSnapshot.name} payment is due on ${formatDate(invoice.dueDate)}.`
      })
    ),
    ...oldPendingInvoices.map((invoice) =>
      invoiceNotification({
        type: 'old-pending-invoice',
        invoice,
        tone: 'info',
        title: `${invoice.invoiceNumber} needs follow-up`,
        description: `${invoice.customerSnapshot.name} has been pending since ${formatDate(invoice.createdAt || invoice.date)}.`
      })
    ),
    ...recentInvoices.map((invoice) =>
      invoiceNotification({
        type: 'invoice-created',
        invoice: { ...invoice, dueDate: null, updatedAt: invoice.createdAt },
        tone: 'info',
        title: `${invoice.invoiceNumber} was created`,
        description: `${invoice.customerSnapshot.name} · ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(invoice.total || 0))}.`
      })
    )
  ]);
};

const countNotifications = async (userId) => {
  const filters = notificationFilters(userId);
  const counts = await Promise.all([
    Product.countDocuments(filters.negativeStock),
    Product.countDocuments(filters.lowStock),
    Invoice.countDocuments(filters.overdueInvoices),
    Invoice.countDocuments(filters.dueSoonInvoices),
    Invoice.countDocuments(filters.oldPendingInvoices),
    Invoice.countDocuments(filters.recentInvoices)
  ]);

  return counts.reduce((sum, count) => sum + count, 0);
};

export const listNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query, { defaultLimit: 10, maxLimit: 50 });
  const rawTotal = await countNotifications(req.user._id);
  const allCandidates = await buildNotifications(req.user._id, rawTotal);
  const states = await NotificationRead.find({
    user: req.user._id,
    notificationId: { $in: allCandidates.map((notification) => notification.id) }
  }).select('notificationId readAt dismissedAt');
  const stateById = new Map(states.map((state) => [state.notificationId, state]));
  const visibleCandidates = allCandidates.filter((notification) => !stateById.get(notification.id)?.dismissedAt);
  const pageNotifications = visibleCandidates.slice(skip, skip + limit);

  const notifications = pageNotifications.map((notification) => ({
    ...notification,
    read: Boolean(stateById.get(notification.id))
  }));
  const unreadCount = visibleCandidates.filter((notification) => !stateById.get(notification.id)).length;

  res.json({
    success: true,
    notifications,
    unreadCount,
    pagination: paginationMeta({ page, limit, total: visibleCandidates.length })
  });
});

export const markNotificationsSeen = asyncHandler(async (req, res) => {
  let notificationIds = Array.isArray(req.body.notificationIds) ? req.body.notificationIds.filter(Boolean) : [];

  if (req.body.all) {
    const rawTotal = await countNotifications(req.user._id);
    const allCandidates = await buildNotifications(req.user._id, rawTotal);
    const dismissed = new Set(
      (
        await NotificationRead.find({
          user: req.user._id,
          dismissedAt: { $ne: null },
          notificationId: { $in: allCandidates.map((notification) => notification.id) }
        }).select('notificationId')
      ).map((state) => state.notificationId)
    );
    notificationIds = allCandidates.map((notification) => notification.id).filter((id) => !dismissed.has(id));
  }

  if (notificationIds.length) {
    await NotificationRead.bulkWrite(
      Array.from(new Set(notificationIds)).map((id) => ({
        updateOne: {
          filter: { user: req.user._id, notificationId: id },
          update: { $set: { readAt: new Date() }, $setOnInsert: { user: req.user._id, notificationId: id } },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  res.json({ success: true });
});

export const dismissNotifications = asyncHandler(async (req, res) => {
  const notificationIds = Array.isArray(req.body.notificationIds) ? req.body.notificationIds.filter(Boolean) : [];

  if (notificationIds.length) {
    await NotificationRead.bulkWrite(
      Array.from(new Set(notificationIds)).map((id) => ({
        updateOne: {
          filter: { user: req.user._id, notificationId: id },
          update: { $set: { dismissedAt: new Date(), readAt: new Date() }, $setOnInsert: { user: req.user._id, notificationId: id } },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  res.json({ success: true });
});
