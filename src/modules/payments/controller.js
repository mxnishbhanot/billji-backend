import { serializeInvoice } from '../../services/invoiceService.js';
import { logAudit } from '../../services/auditService.js';
import { invalidateInvoicePdf } from '../../services/invoicePdfCache.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  applyCreditWorkflow,
  getCustomerCredits,
  getCustomerOutstanding,
  listPayments,
  markInvoiceRefundProcessedWorkflow,
  recordCustomerPaymentWorkflow,
  recordInvoicePaymentWorkflow,
  reverseCreditApplicationWorkflow,
  serializeCreditResult,
  serializeCustomerPaymentResult,
  serializePaymentResult
} from './service.js';

export const listBusinessPayments = asyncHandler(async (req, res) => {
  const payments = await listPayments({
    businessId: req.business._id,
    invoiceId: req.query.invoiceId,
    customerId: req.query.customerId
  });

  res.json({ success: true, payments });
});

export const recordInvoicePayment = asyncHandler(async (req, res) => {
  const result = await recordInvoicePaymentWorkflow({ req });
  // Paid/balance changed — drop any cached PDF so the next render reflects payment.
  void invalidateInvoicePdf(result.invoice);
  void logAudit(req, {
    action: 'payment.recorded',
    resourceType: 'payment',
    resourceId: result.payment._id,
    metadata: { invoiceId: req.params.invoiceId, amount: result.payment.amount, method: result.payment.method }
  });

  res.status(201).json({
    success: true,
    ...serializePaymentResult({
      ...result,
      invoice: serializeInvoice(result.invoice, req)
    })
  });
});

export const markInvoiceRefundProcessed = asyncHandler(async (req, res) => {
  const payments = await markInvoiceRefundProcessedWorkflow({ req });
  void logAudit(req, {
    action: 'payment.refund_processed',
    resourceType: 'invoice',
    resourceId: req.params.invoiceId
  });

  res.json({ success: true, payments });
});

export const listCustomerOutstanding = asyncHandler(async (req, res) => {
  const outstanding = await getCustomerOutstanding(req.business._id, req.params.customerId);
  res.json({ success: true, ...outstanding });
});

export const listCustomerCredits = asyncHandler(async (req, res) => {
  const credits = await getCustomerCredits(req.business._id, req.params.customerId);
  res.json({ success: true, ...credits });
});

export const applyCredit = asyncHandler(async (req, res) => {
  const result = await applyCreditWorkflow({ req });
  // Balance and the new "Credit applied" line changed — the cached PDF is stale.
  void invalidateInvoicePdf(result.invoice);
  void logAudit(req, {
    action: 'payment.credit_applied',
    resourceType: 'invoice',
    resourceId: result.invoice._id,
    metadata: { amount: result.appliedAmount, allocationIds: result.allocations.map((a) => a._id) }
  });

  res.status(201).json({
    success: true,
    ...serializeCreditResult({ ...result, invoice: serializeInvoice(result.invoice, req) })
  });
});

export const reverseCreditApplication = asyncHandler(async (req, res) => {
  const result = await reverseCreditApplicationWorkflow({ req });
  void invalidateInvoicePdf(result.invoice);
  void logAudit(req, {
    action: 'payment.credit_application_reversed',
    resourceType: 'settlement_allocation',
    resourceId: req.params.allocationId,
    metadata: { reversed: result.reversed, reason: req.body.reason || '' }
  });

  res.json({
    success: true,
    ...serializeCreditResult({ ...result, invoice: serializeInvoice(result.invoice, req) })
  });
});

export const recordCustomerPayment = asyncHandler(async (req, res) => {
  const result = await recordCustomerPaymentWorkflow({ req });
  // Every allocated invoice's paid/balance changed — invalidate each cached PDF.
  result.invoices.forEach((invoice) => void invalidateInvoicePdf(invoice));
  void logAudit(req, {
    action: 'payment.recorded',
    resourceType: 'payment',
    resourceId: result.payment._id,
    metadata: {
      customerId: req.params.customerId,
      amount: result.payment.amount,
      method: result.payment.method,
      invoiceIds: req.body.invoiceIds
    }
  });

  res.status(201).json({
    success: true,
    ...serializeCustomerPaymentResult({
      ...result,
      invoices: result.invoices.map((invoice) => serializeInvoice(invoice, req))
    })
  });
});
