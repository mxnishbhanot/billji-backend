import Order from '../../models/Order.js';
import Invoice from '../../models/Invoice.js';

export const createOrderRecord = async (payload, { session } = {}) => {
  const [order] = await Order.create([payload], { session });
  return order;
};

export const findOrderById = (businessId, orderId, { session } = {}) =>
  Order.findOne({ _id: orderId, business: businessId }).session(session || null);

export const listOrderRecords = (filter) => Order.find(filter).lean();

export const countOrderRecords = (filter) => Order.countDocuments(filter);

// OR-2: the live invoice linked to an order, if any. Invoice delete is a hard
// delete, so any matching doc is an active 1->1 link (enforces ORDER_ALREADY_INVOICED).
export const findInvoiceForOrder = (businessId, orderId, { session } = {}) =>
  Invoice.findOne({ business: businessId, sourceOrder: orderId, documentType: 'invoice' }).session(session || null);
