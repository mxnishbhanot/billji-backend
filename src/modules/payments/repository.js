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
    PaymentAllocation.aggregate([
      { $match: { business: businessId, customer: customerId } },
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
