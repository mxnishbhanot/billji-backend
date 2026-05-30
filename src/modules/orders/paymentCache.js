import Order from '../../models/Order.js';
import Invoice from '../../models/Invoice.js';

// OR-3: Order payment fields are a DERIVED read-model only. The authoritative
// chain is Payment -> Invoice -> Order. We aggregate the order's linked,
// non-cancelled invoices (whose paidAmount/balanceDue are themselves maintained
// transactionally by the payment workflow). The order is never an independent
// accounting source of truth.

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

// A "live" invoice contributes to the order's payment view. Cancelled/void
// invoices are excluded (a hard-deleted invoice is simply absent).
const liveInvoiceFilter = (businessId, orderId) => ({
  business: businessId,
  sourceOrder: orderId,
  documentType: 'invoice',
  documentStatus: { $nin: ['cancelled', 'void'] }
});

// Pure read: compute the payment snapshot from linked invoices. No writes.
export const deriveOrderPaymentSnapshot = async (businessId, orderId, { session } = {}) => {
  const invoices = await Invoice.find(liveInvoiceFilter(businessId, orderId))
    .select('total paidAmount')
    .session(session || null)
    .lean();

  if (invoices.length === 0) {
    // No live invoice yet (not generated, or its invoice was cancelled/deleted).
    // Fall back to the order's own total as the amount still owed operationally.
    const order = await Order.findOne({ _id: orderId, business: businessId }).select('total').session(session || null).lean();
    const total = money(order?.total);
    return { paidAmount: 0, balanceDue: total, paymentStatus: 'unpaid', invoiceCount: 0 };
  }

  const invoicedTotal = money(invoices.reduce((sum, inv) => sum + Number(inv.total || 0), 0));
  const paidAmount = money(invoices.reduce((sum, inv) => sum + Number(inv.paidAmount || 0), 0));
  const balanceDue = money(Math.max(invoicedTotal - paidAmount, 0));
  // refunded is intentionally not derived here — it lands with OR-7 (returns).
  const paymentStatus = paidAmount <= 0 ? 'unpaid' : balanceDue <= 0 ? 'paid' : 'partial';

  return { paidAmount, balanceDue, paymentStatus, invoiceCount: invoices.length };
};

// Recompute and persist the cached fields onto the order (list-view optimization).
export const recomputeOrderPaymentCache = async (businessId, orderId, { session } = {}) => {
  const snapshot = await deriveOrderPaymentSnapshot(businessId, orderId, { session });
  await Order.updateOne(
    { _id: orderId, business: businessId },
    { $set: { paidAmount: snapshot.paidAmount, balanceDue: snapshot.balanceDue, paymentStatus: snapshot.paymentStatus } },
    { session }
  );
  return snapshot;
};

// Dispatcher entry point: resolve the affected order from an invoice-related
// event and refresh its cache. No-op for direct invoices (sourceOrder null).
export const recomputeOrderCacheForEvent = async (businessId, { orderId, invoiceId } = {}) => {
  let resolvedOrderId = orderId || null;

  if (!resolvedOrderId && invoiceId) {
    const invoice = await Invoice.findOne({ _id: invoiceId, business: businessId }).select('sourceOrder').lean();
    resolvedOrderId = invoice?.sourceOrder || null;
  }

  if (!resolvedOrderId) return null;
  return recomputeOrderPaymentCache(businessId, resolvedOrderId);
};
