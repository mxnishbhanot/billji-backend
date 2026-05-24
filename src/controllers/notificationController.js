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
  priority: tone === 'danger' ? 1 : 2
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
  priority: tone === 'danger' ? 1 : 2
});

const notificationFilters = (userId) => {
  const today = startOfDay();
  const soonLimit = new Date(today.getTime() + 3 * DAY_MS);
  const oldPendingLimit = new Date(today.getTime() - 7 * DAY_MS);

  return {
    negativeStock: { user: userId, stockQuantity: { $lt: 0 } },
    lowStock: {
      user: userId,
      stockQuantity: { $gte: 0 },
      $expr: { $lte: ['$stockQuantity', '$lowStockThreshold'] }
    },
    overdueInvoices: { user: userId, status: 'pending', dueDate: { $lt: today } },
    dueSoonInvoices: { user: userId, status: 'pending', dueDate: { $gte: today, $lte: soonLimit } },
    oldPendingInvoices: { user: userId, status: 'pending', dueDate: null, createdAt: { $lte: oldPendingLimit } }
  };
};

const sortNotifications = (notifications) =>
  notifications.sort((a, b) => a.priority - b.priority || new Date(b.sortDate || 0) - new Date(a.sortDate || 0));

const buildNotifications = async (userId, fetchLimit) => {
  if (fetchLimit <= 0) {
    return [];
  }

  const filters = notificationFilters(userId);
  const [negativeStock, lowStock, overdueInvoices, dueSoonInvoices, oldPendingInvoices] = await Promise.all([
    Product.find(filters.negativeStock).sort({ updatedAt: -1 }).limit(fetchLimit).lean(),
    Product.find(filters.lowStock).sort({ updatedAt: -1 }).limit(fetchLimit).lean(),
    Invoice.find(filters.overdueInvoices).sort({ dueDate: 1, updatedAt: -1 }).limit(fetchLimit).lean(),
    Invoice.find(filters.dueSoonInvoices).sort({ dueDate: 1, updatedAt: -1 }).limit(fetchLimit).lean(),
    Invoice.find(filters.oldPendingInvoices).sort({ createdAt: 1 }).limit(fetchLimit).lean()
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
    Invoice.countDocuments(filters.oldPendingInvoices)
  ]);

  return counts.reduce((sum, count) => sum + count, 0);
};

export const listNotifications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query, { defaultLimit: 10, maxLimit: 50 });
  const total = await countNotifications(req.user._id);
  const [pageCandidates, allCandidates] = await Promise.all([
    buildNotifications(req.user._id, Math.min(skip + limit, total)),
    buildNotifications(req.user._id, total)
  ]);
  const pageNotifications = pageCandidates.slice(skip, skip + limit);
  const readIds = new Set(
    (
      await NotificationRead.find({
        user: req.user._id,
        notificationId: { $in: allCandidates.map((notification) => notification.id) }
      }).select('notificationId')
    ).map((read) => read.notificationId)
  );

  const notifications = pageNotifications.map((notification) => ({
    ...notification,
    read: readIds.has(notification.id)
  }));
  const unreadCount = allCandidates.filter((notification) => !readIds.has(notification.id)).length;

  res.json({
    success: true,
    notifications,
    unreadCount,
    pagination: paginationMeta({ page, limit, total })
  });
});

export const markNotificationsSeen = asyncHandler(async (req, res) => {
  const notificationIds = Array.isArray(req.body.notificationIds) ? req.body.notificationIds.filter(Boolean) : [];

  if (notificationIds.length) {
    await NotificationRead.bulkWrite(
      Array.from(new Set(notificationIds)).map((id) => ({
        updateOne: {
          filter: { user: req.user._id, notificationId: id },
          update: { $setOnInsert: { user: req.user._id, notificationId: id } },
          upsert: true
        }
      })),
      { ordered: false }
    );
  }

  res.json({ success: true });
});
