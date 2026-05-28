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
  updateCustomerBalance
} from './repository.js';

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

const accountForMethod = (method) => (['bank_transfer', 'card', 'cheque', 'upi', 'wallet'].includes(method) ? 'bank' : 'cash');

const serializePayment = (payment) => (payment.toObject ? payment.toObject() : payment);
const serializeAllocation = (allocation) => (allocation.toObject ? allocation.toObject() : allocation);

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

    const paidAmount = money(Math.min(totalAllocated + allocatedAmount, invoiceTotal));
    const balanceDue = money(Math.max(invoiceTotal - paidAmount, 0));
    invoice.paidAmount = paidAmount;
    invoice.balanceDue = balanceDue;
    invoice.paymentStatus = paidAmount <= 0 ? 'unpaid' : balanceDue <= 0 ? 'paid' : 'partial';
    invoice.status = legacyStatusFor(invoice);
    invoice.updatedBy = req.user._id;
    await invoice.save({ session });

    const ledgerEntries = [{
      business: req.business._id,
      customer: customerId,
      salesDocument: invoice._id,
      invoice: invoice._id,
      payment: payment._id,
      sourceType: 'payment',
      sourceId: payment._id,
      account: accountForMethod(payment.method),
      direction: 'debit',
      amount,
      currency: payment.currency,
      entryDate: receivedAt,
      description: `Payment received for ${invoice.invoiceNumber}`,
      createdBy: req.user._id
    }];

    if (allocatedAmount > 0) {
      ledgerEntries.push({
        business: req.business._id,
        customer: customerId,
        salesDocument: invoice._id,
        invoice: invoice._id,
        payment: payment._id,
        sourceType: 'payment',
        sourceId: payment._id,
        account: 'accounts_receivable',
        direction: 'credit',
        amount: allocatedAmount,
        currency: payment.currency,
        entryDate: receivedAt,
        description: `Receivable settled for ${invoice.invoiceNumber}`,
        createdBy: req.user._id
      });
    }

    if (unappliedAmount > 0) {
      ledgerEntries.push({
        business: req.business._id,
        customer: customerId,
        salesDocument: invoice._id,
        invoice: invoice._id,
        payment: payment._id,
        sourceType: 'payment',
        sourceId: payment._id,
        account: 'customer_credits',
        direction: 'credit',
        amount: unappliedAmount,
        currency: payment.currency,
        entryDate: receivedAt,
        description: `Customer credit from overpayment for ${invoice.invoiceNumber}`,
        createdBy: req.user._id
      });
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

export const listPayments = async ({ businessId, invoiceId, customerId }) => {
  const filter = { business: businessId };

  if (invoiceId) {
    filter.invoice = invoiceId;
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
