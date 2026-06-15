import Invoice from '../../models/Invoice.js';
import { legacyStatusFor } from '../../models/SalesDocument.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../../services/eventBus.js';
import { ApiError } from '../../utils/ApiError.js';
import { withTransaction } from '../../utils/transaction.js';
import {
  allocationTotalForInvoice,
  createLedgerEntries,
  createPaymentAllocation,
  createPaymentRecord,
  customerBalanceTotals,
  listPaymentRecords,
  paymentIdsAllocatedToInvoice,
  updateCustomerBalance
} from './repository.js';

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

const accountForMethod = (method) => (['bank_transfer', 'card', 'cheque', 'upi', 'wallet'].includes(method) ? 'bank' : 'cash');

const serializePayment = (payment) => (payment.toObject ? payment.toObject() : payment);
const serializeAllocation = (allocation) => (allocation.toObject ? allocation.toObject() : allocation);

// Recompute an invoice's paid/balance/status after applying `allocatedAmount`
// on top of whatever was already allocated to it (`totalAllocatedBefore`).
const applyInvoicePayment = (invoice, totalAllocatedBefore, allocatedAmount, actorId) => {
  const invoiceTotal = money(invoice.total);
  const paidAmount = money(Math.min(totalAllocatedBefore + allocatedAmount, invoiceTotal));
  const balanceDue = money(Math.max(invoiceTotal - paidAmount, 0));
  invoice.paidAmount = paidAmount;
  invoice.balanceDue = balanceDue;
  invoice.paymentStatus = paidAmount <= 0 ? 'unpaid' : balanceDue <= 0 ? 'paid' : 'partial';
  invoice.status = legacyStatusFor(invoice);
  invoice.updatedBy = actorId;
  return { paidAmount, balanceDue };
};

const ledgerBase = (req, payment, invoice) => ({
  business: req.business._id,
  customer: payment.customer || null,
  salesDocument: invoice._id,
  invoice: invoice._id,
  payment: payment._id,
  sourceType: 'payment',
  sourceId: payment._id,
  currency: payment.currency,
  createdBy: req.user._id
});

const cashDebitEntry = (req, payment, invoice, amount, entryDate) => ({
  ...ledgerBase(req, payment, invoice),
  account: accountForMethod(payment.method),
  direction: 'debit',
  amount,
  entryDate,
  description: `Payment received for ${invoice.invoiceNumber}`
});

const receivableCreditEntry = (req, payment, invoice, amount, entryDate) => ({
  ...ledgerBase(req, payment, invoice),
  account: 'accounts_receivable',
  direction: 'credit',
  amount,
  entryDate,
  description: `Receivable settled for ${invoice.invoiceNumber}`
});

const customerCreditEntry = (req, payment, invoice, amount, entryDate) => ({
  ...ledgerBase(req, payment, invoice),
  account: 'customer_credits',
  direction: 'credit',
  amount,
  entryDate,
  description: `Customer credit from overpayment for ${invoice.invoiceNumber}`
});

export const paymentBalanceForInvoice = async (businessId, invoiceId, { session } = {}) => {
  const invoice = await Invoice.findOne({ _id: invoiceId, business: businessId, documentType: 'invoice' }).session(session || null);
  if (!invoice) throw new ApiError(404, 'Invoice not found');

  const allocated = money(await allocationTotalForInvoice(businessId, invoice._id, { session }));
  const total = money(invoice.total);
  return {
    invoice,
    paidAmount: Math.min(allocated, total),
    balanceDue: Math.max(total - allocated, 0),
    totalAllocated: allocated
  };
};

export const recordInvoicePaymentWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const amount = money(req.body.amount);
    if (amount <= 0) throw new ApiError(422, 'Payment amount must be greater than zero');

    const { invoice, totalAllocated } = await paymentBalanceForInvoice(req.business._id, req.params.invoiceId, { session });
    if (['cancelled', 'void'].includes(invoice.documentStatus)) {
      throw new ApiError(409, 'Cannot record payment for a cancelled invoice');
    }

    const invoiceTotal = money(invoice.total);
    const currentBalance = Math.max(invoiceTotal - totalAllocated, 0);
    const allocatedAmount = money(Math.min(amount, currentBalance));
    const unappliedAmount = money(amount - allocatedAmount);
    const customerId = invoice.customer || null;

    if (!customerId && unappliedAmount > 0) {
      throw new ApiError(422, 'Overpayment requires a saved customer');
    }

    const receivedAt = req.body.receivedAt ? new Date(req.body.receivedAt) : new Date();
    const payment = await createPaymentRecord({
      business: req.business._id,
      customer: customerId,
      salesDocument: invoice._id,
      invoice: invoice._id,
      createdBy: req.user._id,
      updatedBy: req.user._id,
      type: req.body.type || 'receipt',
      method: req.body.method || 'cash',
      status: 'completed',
      amount,
      allocatedAmount,
      unappliedAmount,
      currency: req.body.currency || 'INR',
      reference: req.body.reference || '',
      notes: req.body.notes || '',
      receivedAt,
      provider: req.body.provider || {},
      statusHistory: [{ status: 'completed', at: receivedAt, note: req.body.notes || 'Payment recorded' }],
      metadata: req.body.metadata || {}
    }, { session });

    let allocation = null;
    if (allocatedAmount > 0) {
      allocation = await createPaymentAllocation({
        business: req.business._id,
        payment: payment._id,
        salesDocument: invoice._id,
        invoice: invoice._id,
        customer: customerId,
        amount: allocatedAmount,
        allocatedAt: receivedAt,
        createdBy: req.user._id
      }, { session });
    }

    applyInvoicePayment(invoice, totalAllocated, allocatedAmount, req.user._id);
    await invoice.save({ session });

    const ledgerEntries = [cashDebitEntry(req, payment, invoice, amount, receivedAt)];
    if (allocatedAmount > 0) {
      ledgerEntries.push(receivableCreditEntry(req, payment, invoice, allocatedAmount, receivedAt));
    }
    if (unappliedAmount > 0) {
      ledgerEntries.push(customerCreditEntry(req, payment, invoice, unappliedAmount, receivedAt));
    }

    await createLedgerEntries(ledgerEntries, { session });

    let customerBalance = null;
    if (customerId) {
      const totals = await customerBalanceTotals(req.business._id, customerId, { session });
      customerBalance = await updateCustomerBalance(req.business._id, customerId, totals, { session, actorId: req.user._id });
    }

    await publishDomainEvent(
      {
        business: req.business._id,
        actor: req.user._id,
        eventType: DOMAIN_EVENTS.paymentRecorded,
        aggregateType: 'payment',
        aggregateId: payment._id,
        payload: {
          paymentId: payment._id,
          invoiceId: invoice._id,
          sourceOrder: invoice.sourceOrder || null,
          invoiceNumber: invoice.invoiceNumber,
          customerId,
          customerName: invoice.customerSnapshot?.name,
          amount,
          allocatedAmount,
          unappliedAmount,
          currency: payment.currency,
          method: payment.method,
          receivedAt
        },
        dedupeKey: `${DOMAIN_EVENTS.paymentRecorded}:${payment._id}`
      },
      { session }
    );

    return { payment, allocation, invoice, customerBalance };
  });

// Outstanding (unpaid/partial) invoices for a customer, oldest-first, with the
// canonical balanceDue derived from allocations (not the denormalized field).
export const getCustomerOutstanding = async (businessId, customerId) => {
  const invoices = await Invoice.find({
    business: businessId,
    customer: customerId,
    documentType: 'invoice',
    documentStatus: { $nin: ['cancelled', 'void'] },
    paymentStatus: { $in: ['unpaid', 'partial'] }
  })
    .sort({ date: 1, createdAt: 1 })
    .lean();

  const rows = [];
  let totalOutstanding = 0;
  for (const invoice of invoices) {
    const allocated = money(await allocationTotalForInvoice(businessId, invoice._id));
    const balanceDue = money(Math.max(money(invoice.total) - allocated, 0));
    if (balanceDue <= 0) continue;
    totalOutstanding = money(totalOutstanding + balanceDue);
    rows.push({
      id: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      date: invoice.date,
      total: money(invoice.total),
      balanceDue
    });
  }

  return { invoices: rows, totalOutstanding };
};

// Record ONE payment from a customer and allocate it across multiple invoices in
// priority order (`invoiceIds`: dues oldest->newest, then the new invoice last).
// Greedy: each invoice is filled to its balance; any leftover becomes customer credit.
export const recordCustomerPaymentWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const amount = money(req.body.amount);
    if (amount <= 0) throw new ApiError(422, 'Payment amount must be greater than zero');

    const invoiceIds = Array.isArray(req.body.invoiceIds) ? req.body.invoiceIds : [];
    if (!invoiceIds.length) throw new ApiError(422, 'At least one invoice is required');

    const customerId = req.params.customerId;

    // Load + validate every target invoice (server is source of truth for balances).
    const targets = [];
    for (const invoiceId of invoiceIds) {
      const { invoice, totalAllocated } = await paymentBalanceForInvoice(req.business._id, invoiceId, { session });
      if (['cancelled', 'void'].includes(invoice.documentStatus)) {
        throw new ApiError(409, `Cannot record payment for cancelled invoice ${invoice.invoiceNumber}`);
      }
      if (String(invoice.customer || '') !== String(customerId)) {
        throw new ApiError(422, `Invoice ${invoice.invoiceNumber} does not belong to this customer`);
      }
      const balance = money(Math.max(money(invoice.total) - money(totalAllocated), 0));
      targets.push({ invoice, totalAllocated, balance, allocatedAmount: 0 });
    }

    // Greedy fill in the order received.
    let remaining = amount;
    for (const target of targets) {
      const alloc = money(Math.min(remaining, target.balance));
      target.allocatedAmount = alloc;
      remaining = money(remaining - alloc);
    }
    const unappliedAmount = money(remaining);
    const allocatedTotal = money(amount - unappliedAmount);

    // Use the invoice's ObjectId customer ref (the route param is a string and
    // would not match in the customer-balance aggregates).
    const customerRef = targets[0].invoice.customer || null;
    // allowCredit defaults to true (e.g. settling dues + a new invoice). When the
    // caller is purely collecting dues, it passes false so an overpayment is rejected
    // instead of silently parked as customer credit.
    const allowCredit = req.body.allowCredit !== false;
    if (unappliedAmount > 0 && !allowCredit) {
      throw new ApiError(422, "Amount exceeds the selected invoices' outstanding balance");
    }
    if (unappliedAmount > 0 && !customerRef) {
      throw new ApiError(422, 'Overpayment requires a saved customer');
    }

    const lastInvoice = targets[targets.length - 1].invoice;
    const receivedAt = req.body.receivedAt ? new Date(req.body.receivedAt) : new Date();

    const payment = await createPaymentRecord({
      business: req.business._id,
      customer: customerRef,
      salesDocument: lastInvoice._id,
      invoice: lastInvoice._id,
      createdBy: req.user._id,
      updatedBy: req.user._id,
      type: req.body.type || 'receipt',
      method: req.body.method || 'cash',
      status: 'completed',
      amount,
      allocatedAmount: allocatedTotal,
      unappliedAmount,
      currency: req.body.currency || 'INR',
      reference: req.body.reference || '',
      notes: req.body.notes || '',
      receivedAt,
      provider: req.body.provider || {},
      statusHistory: [{ status: 'completed', at: receivedAt, note: req.body.notes || 'Payment recorded' }],
      metadata: req.body.metadata || {}
    }, { session });

    const allocations = [];
    const ledgerEntries = [cashDebitEntry(req, payment, lastInvoice, amount, receivedAt)];

    for (const target of targets) {
      if (target.allocatedAmount <= 0) continue;
      const allocation = await createPaymentAllocation({
        business: req.business._id,
        payment: payment._id,
        salesDocument: target.invoice._id,
        invoice: target.invoice._id,
        customer: customerRef,
        amount: target.allocatedAmount,
        allocatedAt: receivedAt,
        createdBy: req.user._id
      }, { session });
      allocations.push(allocation);

      applyInvoicePayment(target.invoice, target.totalAllocated, target.allocatedAmount, req.user._id);
      await target.invoice.save({ session });
      ledgerEntries.push(receivableCreditEntry(req, payment, target.invoice, target.allocatedAmount, receivedAt));
    }

    if (unappliedAmount > 0) {
      ledgerEntries.push(customerCreditEntry(req, payment, lastInvoice, unappliedAmount, receivedAt));
    }

    await createLedgerEntries(ledgerEntries, { session });

    let customerBalance = null;
    if (customerRef) {
      const totals = await customerBalanceTotals(req.business._id, customerRef, { session });
      customerBalance = await updateCustomerBalance(req.business._id, customerRef, totals, { session, actorId: req.user._id });
    }

    await publishDomainEvent(
      {
        business: req.business._id,
        actor: req.user._id,
        eventType: DOMAIN_EVENTS.paymentRecorded,
        aggregateType: 'payment',
        aggregateId: payment._id,
        payload: {
          paymentId: payment._id,
          invoiceId: lastInvoice._id,
          invoiceNumber: lastInvoice.invoiceNumber,
          allocations: allocations.map((a) => ({ invoiceId: a.invoice, amount: a.amount })),
          customerId: customerRef,
          customerName: lastInvoice.customerSnapshot?.name,
          amount,
          allocatedAmount: allocatedTotal,
          unappliedAmount,
          currency: payment.currency,
          method: payment.method,
          receivedAt
        },
        dedupeKey: `${DOMAIN_EVENTS.paymentRecorded}:${payment._id}`
      },
      { session }
    );

    return { payment, allocations, invoices: targets.map((target) => target.invoice), customerBalance };
  });

export const listPayments = async ({ businessId, invoiceId, customerId }) => {
  const filter = { business: businessId };

  if (invoiceId) {
    // Include payments allocated to this invoice even when the payment's own
    // `invoice` field points at a different (e.g. last) invoice.
    const allocatedPaymentIds = await paymentIdsAllocatedToInvoice(businessId, invoiceId);
    filter.$or = [{ invoice: invoiceId }, { _id: { $in: allocatedPaymentIds } }];
  }
  if (customerId) filter.customer = customerId;

  const payments = await listPaymentRecords(filter);
  return payments.map(serializePayment);
};

export const serializePaymentResult = ({ payment, allocation, invoice, customerBalance }) => ({
  payment: serializePayment(payment),
  allocation: allocation ? serializeAllocation(allocation) : null,
  invoice,
  customerBalance: customerBalance ? serializePayment(customerBalance) : null
});

export const serializeCustomerPaymentResult = ({ payment, allocations, invoices, customerBalance }) => ({
  payment: serializePayment(payment),
  allocations: (allocations || []).map(serializeAllocation),
  invoices,
  customerBalance: customerBalance ? serializePayment(customerBalance) : null
});
