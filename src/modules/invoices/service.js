import { buildInvoicePayload, getInvoiceForBusiness, setInvoicePdfUrl, stockAdjustmentsForInvoice } from '../../services/invoiceService.js';
import { invalidateInvoicePdf } from '../../services/invoicePdfCache.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../../services/eventBus.js';
import Payment from '../../models/Payment.js';
import { domainStatusesForLegacy } from '../../models/SalesDocument.js';
import { customerBalanceTotals, updateCustomerBalance } from '../payments/repository.js';
import { ApiError } from '../../utils/ApiError.js';
import { withTransaction } from '../../utils/transaction.js';
import { createInvoiceRecord, deleteInvoiceRecord } from './repository.js';

export const publishInvoiceIssuedEvent = (req, invoice, { session, suffix = 'issued' } = {}) =>
  publishDomainEvent(
    {
      business: req.business._id,
      actor: req.user._id,
      eventType: DOMAIN_EVENTS.documentIssued,
      aggregateType: 'sales_document',
      aggregateId: invoice._id,
      payload: {
        documentType: invoice.documentType || 'invoice',
        documentNumber: invoice.documentNumber || invoice.invoiceNumber,
        invoiceNumber: invoice.invoiceNumber,
        invoiceId: invoice._id,
        sourceOrder: invoice.sourceOrder || null,
        customerId: invoice.customer,
        customerName: invoice.customerSnapshot?.name,
        total: invoice.total,
        currency: 'INR'
      },
      dedupeKey: `${DOMAIN_EVENTS.documentIssued}:${invoice._id}:${suffix}`
    },
    { session }
  );

const publishInvoiceCancelledEvent = (req, invoice, { session, suffix = 'cancelled' } = {}) =>
  publishDomainEvent(
    {
      business: req.business._id,
      actor: req.user._id,
      eventType: DOMAIN_EVENTS.documentCancelled,
      aggregateType: 'sales_document',
      aggregateId: invoice._id,
      payload: {
        documentType: invoice.documentType || 'invoice',
        documentNumber: invoice.documentNumber || invoice.invoiceNumber,
        invoiceNumber: invoice.invoiceNumber,
        invoiceId: invoice._id,
        sourceOrder: invoice.sourceOrder || null,
        customerId: invoice.customer,
        customerName: invoice.customerSnapshot?.name,
        total: invoice.total
      },
      dedupeKey: `${DOMAIN_EVENTS.documentCancelled}:${invoice._id}:${suffix}`
    },
    { session }
  );

export const publishStockAdjustedEvents = (req, movements, { session } = {}) =>
  Promise.all(
    movements.map((movement) =>
      publishDomainEvent(
        {
          business: req.business._id,
          actor: req.user._id,
          eventType: DOMAIN_EVENTS.stockAdjusted,
          aggregateType: 'product',
          aggregateId: movement.productId,
          payload: movement,
          dedupeKey: `${DOMAIN_EVENTS.stockAdjusted}:${movement.movementId}`
        },
        { session }
      )
    )
  );

export const createInvoiceWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const payload = await buildInvoicePayload(req.user, req.business, req.body, { session });
    const invoice = await createInvoiceRecord(payload, { session });

    await setInvoicePdfUrl(invoice, req, { session });
    const movements = await stockAdjustmentsForInvoice(invoice, -1, { session, allowOversell: Boolean(req.body.allowOversell) });
    await publishInvoiceIssuedEvent(req, invoice, { session });
    await publishStockAdjustedEvents(req, movements, { session });

    return invoice;
  });

export const duplicateInvoiceWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const invoice = await getInvoiceForBusiness(req.business._id, req.params.id, { session });
    const payload = await buildInvoicePayload(req.user, req.business, {
      customerId: invoice.customer,
      customer: invoice.customerSnapshot,
      items: invoice.items.map((item) => ({
        productId: item.product,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        sku: item.sku
      })),
      taxRate: invoice.tax.rate,
      discountType: invoice.discount.type,
      discountValue: invoice.discount.value,
      status: 'pending',
      notes: invoice.notes
    }, { session });
    const clone = await createInvoiceRecord(payload, { session });

    await setInvoicePdfUrl(clone, req, { session });
    const movements = await stockAdjustmentsForInvoice(clone, -1, { session });
    await publishInvoiceIssuedEvent(req, clone, { session, suffix: `duplicated:${invoice._id}` });
    await publishStockAdjustedEvents(req, movements, { session });

    return clone;
  });

const assertInvoiceHasNoPayments = async (invoice, action, { session } = {}) => {
  const payment = await Payment.exists({ business: invoice.business, invoice: invoice._id }).session(session || null);
  if (payment) {
    throw new ApiError(409, `Invoice has recorded payments and cannot be ${action}`, {
      code: 'INVOICE_HAS_PAYMENTS'
    });
  }
};

const refreshCustomerBalanceForInvoice = async (req, invoice, { session } = {}) => {
  if (!invoice.customer) return null;
  const totals = await customerBalanceTotals(req.business._id, invoice.customer, { session });
  return updateCustomerBalance(req.business._id, invoice.customer, totals, { session, actorId: req.user._id });
};

export const cancelInvoiceWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const invoice = await getInvoiceForBusiness(req.business._id, req.params.id, { session });

    if (invoice.documentStatus === 'cancelled' || invoice.status === 'cancelled') {
      return invoice;
    }

    await assertInvoiceHasNoPayments(invoice, 'cancelled', { session });

    invoice.updatedBy = req.user._id;
    invoice.status = 'cancelled';
    const domainStatuses = domainStatusesForLegacy('cancelled');
    invoice.documentStatus = domainStatuses.documentStatus;
    invoice.paymentStatus = domainStatuses.paymentStatus;
    invoice.paidAmount = 0;
    invoice.balanceDue = 0;

    const movements = await stockAdjustmentsForInvoice(invoice, 1, { session });
    await invoice.save({ session });
    await refreshCustomerBalanceForInvoice(req, invoice, { session });
    await publishInvoiceCancelledEvent(req, invoice, { session });
    await publishStockAdjustedEvents(req, movements, { session });

    // Cancelling re-renders the PDF (CANCELLED watermark / status) — drop the cache.
    void invalidateInvoicePdf(invoice);

    return invoice;
  });

export const deleteInvoiceWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const invoice = await getInvoiceForBusiness(req.business._id, req.params.id, { session });
    const isAlreadyCancelled = invoice.documentStatus === 'cancelled' || invoice.status === 'cancelled';

    await assertInvoiceHasNoPayments(invoice, 'deleted', { session });

    invoice.updatedBy = req.user._id;
    const movements = isAlreadyCancelled ? [] : await stockAdjustmentsForInvoice(invoice, 1, { session });
    await publishInvoiceCancelledEvent(req, invoice, { session, suffix: 'deleted' });
    await publishStockAdjustedEvents(req, movements, { session });
    await deleteInvoiceRecord(invoice, { session });
    await refreshCustomerBalanceForInvoice(req, invoice, { session });

    // Document gone — purge any cached PDF.
    void invalidateInvoicePdf(invoice);

    return invoice;
  });
