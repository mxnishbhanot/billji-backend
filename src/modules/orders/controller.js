import { asyncHandler } from '../../utils/asyncHandler.js';
import { logAudit } from '../../services/auditService.js';
import { emitBusinessEvent } from '../../services/socketService.js';
import { paginateQuery, UNPAGINATED_LIST_CAP, wantsPagination } from '../../utils/pagination.js';
import { buildSearchRegex } from '../../utils/searchRegex.js';
import { serializeInvoice } from '../../services/invoiceService.js';
import { deriveOrderPaymentSnapshot } from './paymentCache.js';
import { ORDER_SORT_OPTIONS } from './schema.js';
import { countOrderRecords, findInvoiceForOrder, listOrderRecords } from './repository.js';
import { cancelOrderWorkflow, createOrderWorkflow, generateInvoiceForOrderWorkflow, getOrderForBusiness } from './service.js';

export const serializeOrder = (order) => {
  const data = order.toObject ? order.toObject() : order;
  const paidAmount = data.paidAmount ?? 0;
  const balanceDue = data.balanceDue ?? Math.max(Number(data.total || 0) - Number(paidAmount), 0);

  return { ...data, paidAmount, balanceDue };
};

const parseDateParam = (value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
};
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

const emitOrderChanges = (businessId, reason) => emitBusinessEvent(businessId, 'orders:changed', { reason });

export const listOrders = asyncHandler(async (req, res) => {
  const { search = '', orderStatus, paymentStatus, fulfillmentStatus, customerId, from, to, minAmount, maxAmount, sort } = req.query;
  const filter = { business: req.business._id };

  if (orderStatus) {
    filter.orderStatus = orderStatus;
  }

  if (paymentStatus) {
    filter.paymentStatus = paymentStatus;
  }

  if (fulfillmentStatus) {
    filter.fulfillmentStatus = fulfillmentStatus;
  }

  if (customerId) {
    filter.customer = customerId;
  }

  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = startOfDay(parseDateParam(from));
    if (to) filter.date.$lte = endOfDay(parseDateParam(to));
  }

  if (minAmount || maxAmount) {
    filter.total = {};
    if (minAmount) filter.total.$gte = Number(minAmount);
    if (maxAmount) filter.total.$lte = Number(maxAmount);
  }

  const searchRegex = buildSearchRegex(search);
  if (searchRegex) {
    filter.$or = [
      { orderNumber: searchRegex },
      { 'customerSnapshot.name': searchRegex },
      { 'customerSnapshot.phone': searchRegex }
    ];
  }

  const sortSpec = ORDER_SORT_OPTIONS[sort] || ORDER_SORT_OPTIONS.newest;
  const queryBuilder = listOrderRecords(filter).sort(sortSpec);

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(queryBuilder, countOrderRecords(filter), req.query);
    return res.json({ success: true, orders: items.map(serializeOrder), pagination });
  }

  const orders = await queryBuilder.limit(UNPAGINATED_LIST_CAP);
  res.json({ success: true, orders: orders.map(serializeOrder) });
});

export const createOrder = asyncHandler(async (req, res) => {
  const order = await createOrderWorkflow({ req });

  void logAudit(req, { action: 'order.created', resourceType: 'order', resourceId: order._id, metadata: { orderNumber: order.orderNumber, total: order.total } });
  emitOrderChanges(req.business._id, 'order_created');
  res.status(201).json({ success: true, order: serializeOrder(order) });
});

export const getOrder = asyncHandler(async (req, res) => {
  const order = await getOrderForBusiness(req.business._id, req.params.id);
  // Detail view derives payment fields live from linked invoices (authoritative),
  // so it is correct even if the cached list-view fields lag an outbox event.
  const snapshot = await deriveOrderPaymentSnapshot(req.business._id, order._id);
  // Expose the linked invoice (if any) so the client can deep-link Order -> Invoice.
  const linkedInvoice = await findInvoiceForOrder(req.business._id, order._id);
  res.json({
    success: true,
    order: {
      ...serializeOrder(order),
      ...snapshot,
      linkedInvoice: linkedInvoice ? { id: linkedInvoice._id, invoiceNumber: linkedInvoice.invoiceNumber, status: linkedInvoice.status } : null
    }
  });
});

export const generateInvoiceFromOrder = asyncHandler(async (req, res) => {
  const invoice = await generateInvoiceForOrderWorkflow({ req });

  void logAudit(req, { action: 'invoice.created', resourceType: 'invoice', resourceId: invoice._id, metadata: { invoiceNumber: invoice.invoiceNumber, total: invoice.total, sourceOrder: invoice.sourceOrder } });
  void logAudit(req, { action: 'order.invoiced', resourceType: 'order', resourceId: invoice.sourceOrder, metadata: { invoiceNumber: invoice.invoiceNumber } });
  emitOrderChanges(req.business._id, 'order_invoiced');
  emitBusinessEvent(req.business._id, 'invoices:changed', { reason: 'order_invoiced' });
  res.status(201).json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const cancelOrder = asyncHandler(async (req, res) => {
  const order = await cancelOrderWorkflow({ req });

  void logAudit(req, { action: 'order.cancelled', resourceType: 'order', resourceId: order._id, metadata: { orderNumber: order.orderNumber } });
  emitOrderChanges(req.business._id, 'order_cancelled');
  res.json({ success: true, order: serializeOrder(order) });
});
