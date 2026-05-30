import {
  buildCustomerSnapshot,
  buildInvoicePayload,
  normalizeItems,
  setInvoicePdfUrl,
  stockAdjustmentsForInvoice
} from '../../services/invoiceService.js';
import { createInvoiceRecord } from '../invoices/repository.js';
import { publishInvoiceIssuedEvent, publishStockAdjustedEvents } from '../invoices/service.js';
import { calculateInvoiceTotals } from '../../utils/invoiceMath.js';
import { nextOrderNumber } from '../../services/numberingService.js';
import { withTransaction } from '../../utils/transaction.js';
import { ApiError } from '../../utils/ApiError.js';
import { createOrderRecord, findInvoiceForOrder, findOrderById } from './repository.js';

// Orders never touch stock (reservations are deferred to OR-5), so item
// normalization runs with allowOversell so availability never blocks an order.
export const buildOrderPayload = async (user, business, payload, { session } = {}) => {
  const { customerId, snapshot } = await buildCustomerSnapshot(business._id, payload, { session });
  const items = await normalizeItems(business._id, payload.items, { allowOversell: true, session });
  const totals = calculateInvoiceTotals({
    items,
    taxRate: payload.taxRate,
    discountType: payload.discountType,
    discountValue: payload.discountValue
  });
  const date = payload.date ? new Date(payload.date) : new Date();
  const orderNumber = await nextOrderNumber({ business, session });

  return {
    business: business._id,
    createdBy: user._id,
    updatedBy: user._id,
    customer: customerId,
    customerSnapshot: snapshot,
    orderNumber,
    date,
    items: totals.items,
    subtotal: totals.subtotal,
    tax: totals.tax,
    discount: totals.discount,
    total: totals.total,
    orderStatus: 'draft',
    fulfillmentStatus: 'pending',
    // Derived cache (authoritative source is linked invoices — see OR-3).
    paymentStatus: 'unpaid',
    paidAmount: 0,
    balanceDue: totals.total,
    notes: payload.notes || ''
  };
};

export const createOrderWorkflow = async ({ req }) => {
  const payload = await buildOrderPayload(req.user, req.business, req.body);
  return createOrderRecord(payload);
};

export const getOrderForBusiness = async (businessId, orderId, { session } = {}) => {
  const order = await findOrderById(businessId, orderId, { session });

  if (!order) {
    throw new ApiError(404, 'Order not found');
  }

  return order;
};

export const cancelOrderWorkflow = async ({ req }) => {
  const order = await getOrderForBusiness(req.business._id, req.params.id);

  if (order.orderStatus === 'cancelled') {
    return order;
  }

  // OR-2 lifecycle rule: once an order has spawned an invoice, the invoice is
  // the authoritative financial document (stock + ledger committed). Cancelling
  // the order would silently desync it from a live invoice, so block it. The
  // reversal path is to void/credit-note the invoice (deferred phase), not the
  // order. Before any invoice exists, cancel is free (no stock/ledger impact).
  const linkedInvoice = await findInvoiceForOrder(req.business._id, order._id);
  if (linkedInvoice) {
    throw new ApiError(409, 'Order has a generated invoice and cannot be cancelled', {
      code: 'ORDER_ALREADY_INVOICED_CANNOT_CANCEL',
      invoiceId: linkedInvoice._id,
      invoiceNumber: linkedInvoice.invoiceNumber
    });
  }

  order.orderStatus = 'cancelled';
  order.updatedBy = req.user._id;
  await order.save();

  return order;
};

// OR-2: turn an order into exactly one invoice via the proven invoice path
// (numbering, stock deduction, ledger-on-issue, share token, PDF) so it behaves
// identically to a direct invoice. Stamps sourceOrder; enforces 1->1; wrapped in
// a transaction. Idempotency middleware guards double-taps at the route layer.
export const generateInvoiceForOrderWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const order = await getOrderForBusiness(req.business._id, req.params.id, { session });

    if (order.orderStatus === 'cancelled') {
      throw new ApiError(409, 'A cancelled order cannot be invoiced', { code: 'ORDER_CANCELLED' });
    }

    const existing = await findInvoiceForOrder(req.business._id, order._id, { session });
    if (existing) {
      throw new ApiError(409, 'Order has already been invoiced', {
        code: 'ORDER_ALREADY_INVOICED',
        invoiceId: existing._id,
        invoiceNumber: existing.invoiceNumber
      });
    }

    // Rebuild the invoice from the order's own snapshot/items so totals and
    // customer match the order exactly (same shape duplicateInvoiceWorkflow uses).
    const invoiceInput = {
      customerId: order.customer || undefined,
      customer: order.customer ? undefined : order.customerSnapshot,
      items: order.items.map((item) => ({
        productId: item.product || undefined,
        name: item.name,
        sku: item.sku,
        quantity: item.quantity,
        price: item.price
      })),
      taxRate: order.tax?.rate,
      discountType: order.discount?.type,
      discountValue: order.discount?.value,
      status: 'pending',
      notes: order.notes,
      allowOversell: Boolean(req.body?.allowOversell)
    };

    const payload = await buildInvoicePayload(req.user, req.business, invoiceInput, { session });
    payload.sourceOrder = order._id;

    const invoice = await createInvoiceRecord(payload, { session });
    await setInvoicePdfUrl(invoice, req, { session });
    const movements = await stockAdjustmentsForInvoice(invoice, -1, { session, allowOversell: invoiceInput.allowOversell });
    await publishInvoiceIssuedEvent(req, invoice, { session, suffix: `order:${order._id}` });
    await publishStockAdjustedEvents(req, movements, { session });

    // Order transitions draft -> confirmed once it has produced an invoice.
    order.orderStatus = 'confirmed';
    order.updatedBy = req.user._id;
    await order.save({ session });

    return invoice;
  });
