import { serializeInvoice } from '../../services/invoiceService.js';
import { logAudit } from '../../services/auditService.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  getCustomerOutstanding,
  listPayments,
  recordCustomerPaymentWorkflow,
  recordInvoicePaymentWorkflow,
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

export const listCustomerOutstanding = asyncHandler(async (req, res) => {
  const outstanding = await getCustomerOutstanding(req.business._id, req.params.customerId);
  res.json({ success: true, ...outstanding });
});

export const recordCustomerPayment = asyncHandler(async (req, res) => {
  const result = await recordCustomerPaymentWorkflow({ req });
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
