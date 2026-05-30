import { buildInvoicePayload, getInvoiceForBusiness, setInvoicePdfUrl, stockAdjustmentsForInvoice } from '../../services/invoiceService.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../../services/eventBus.js';
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

export const deleteInvoiceWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const invoice = await getInvoiceForBusiness(req.business._id, req.params.id, { session });

    invoice.updatedBy = req.user._id;
    const movements = await stockAdjustmentsForInvoice(invoice, 1, { session });
    await publishInvoiceCancelledEvent(req, invoice, { session, suffix: 'deleted' });
    await publishStockAdjustedEvents(req, movements, { session });
    await deleteInvoiceRecord(invoice, { session });

    return invoice;
  });
