import Customer from '../../models/Customer.js';
import CustomerBalance from '../../models/CustomerBalance.js';
import Invoice from '../../models/Invoice.js';
import LedgerEntry from '../../models/LedgerEntry.js';
import Payment from '../../models/Payment.js';
import PaymentAllocation from '../../models/PaymentAllocation.js';

export const createPaymentRecord = async (payload, { session } = {}) => {
  const [payment] = await Payment.create([payload], { session });
  return payment;
};

export const createPaymentAllocation = async (payload, { session } = {}) => {
  const [allocation] = await PaymentAllocation.create([payload], { session });
  return allocation;
};

export const createLedgerEntries = (entries, { session } = {}) => LedgerEntry.create(entries, { session, ordered: true });

// Original (non-reversal) ledger entries booked for an invoice — used to build
// compensating reversal entries on cancel. Excludes prior 'adjustment' reversals.
export const ledgerEntriesForInvoice = (businessId, invoiceId, { session } = {}) =>
  LedgerEntry.find({ business: businessId, invoice: invoiceId, sourceType: { $in: ['invoice', 'payment'] } })
    .session(session || null)
    .lean();

export const invoiceHasLedgerEntries = (businessId, invoiceId, { session } = {}) =>
  LedgerEntry.exists({ business: businessId, invoice: invoiceId }).session(session || null);

// Flag receipts recorded against this invoice as refund-pending. Scoped to
// single-invoice payments (`invoice` field); multi-invoice settlements are left
// untouched since they remain valid against their other allocations.
export const markInvoicePaymentsRefundPending = (businessId, invoiceId, { session } = {}) =>
  Payment.updateMany(
    { business: businessId, invoice: invoiceId, type: 'receipt', status: 'completed', refundStatus: { $ne: 'pending' } },
    { $set: { refundStatus: 'pending' } },
    { session }
  );

// Any money touched this invoice — direct payment OR an allocation from a
// multi-invoice payment whose own `invoice` field points elsewhere.
export const invoiceHasPayments = async (businessId, invoiceId, { session } = {}) => {
  const [direct, allocated] = await Promise.all([
    Payment.exists({ business: businessId, invoice: invoiceId }).session(session || null),
    PaymentAllocation.exists({ business: businessId, invoice: invoiceId }).session(session || null)
  ]);
  return Boolean(direct || allocated);
};

export const allocationTotalForInvoice = async (businessId, invoiceId, { session } = {}) => {
  const result = await PaymentAllocation.aggregate([
    { $match: { business: businessId, invoice: invoiceId } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]).session(session || null);

  return result[0]?.total || 0;
};

export const customerBalanceTotals = async (businessId, customerId, { session } = {}) => {
  const [invoiceTotals, allocationTotals, unappliedTotals] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          business: businessId,
          documentType: 'invoice',
          customer: customerId,
          documentStatus: { $nin: ['cancelled', 'void'] }
        }
      },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]).session(session || null),
    // Exclude allocations tied to cancelled/void invoices: when an invoice is
    // cancelled we keep its payment + allocation for audit, but that money must
    // not settle the customer's other open invoices (it is owed back as a
    // pending refund, tracked on the Payment itself).
    PaymentAllocation.aggregate([
      { $match: { business: businessId, customer: customerId } },
      { $lookup: { from: 'salesdocuments', localField: 'invoice', foreignField: '_id', as: 'doc' } },
      { $match: { 'doc.documentStatus': { $nin: ['cancelled', 'void'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).session(session || null),
    Payment.aggregate([
      { $match: { business: businessId, customer: customerId, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$unappliedAmount' } } }
    ]).session(session || null)
  ]);

  const invoiced = invoiceTotals[0]?.total || 0;
  const allocated = allocationTotals[0]?.total || 0;
  const unapplied = unappliedTotals[0]?.total || 0;

  return {
    outstandingDues: Math.max(invoiced - allocated, 0),
    creditBalance: Math.max(allocated + unapplied - invoiced, 0)
  };
};

export const updateCustomerBalance = async (businessId, customerId, totals, { session, actorId } = {}) => {
  const now = new Date();
  const balance = await CustomerBalance.findOneAndUpdate(
    { business: businessId, customer: customerId },
    { ...totals, lastCalculatedAt: now },
    { new: true, runValidators: true, upsert: true, setDefaultsOnInsert: true, session }
  );

  await Customer.findOneAndUpdate(
    { _id: customerId, business: businessId },
    { creditBalance: totals.creditBalance, outstandingDues: totals.outstandingDues, updatedBy: actorId || null },
    { session }
  );

  return balance;
};

export const listPaymentRecords = (filter) => Payment.find(filter).sort({ receivedAt: -1, createdAt: -1 });

// Payment ids that were allocated to a given invoice (covers multi-invoice
// payments whose stored `invoice` field points at a different invoice).
export const paymentIdsAllocatedToInvoice = async (businessId, invoiceId) => {
  const allocations = await PaymentAllocation.find({ business: businessId, invoice: invoiceId }).select('payment').lean();
  return allocations.map((allocation) => allocation.payment);
};
