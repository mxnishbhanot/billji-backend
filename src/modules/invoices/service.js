import { buildInvoicePayload, getInvoiceForBusiness, setInvoicePdfUrl, stockAdjustmentsForInvoice } from '../../services/invoiceService.js';
import { invalidateInvoicePdf } from '../../services/invoicePdfCache.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../../services/eventBus.js';
import StockMovement from '../../models/StockMovement.js';
import {
  createLedgerEntries,
  customerBalanceTotals,
  invoiceHasLedgerEntries,
  invoiceHasPayments,
  ledgerEntriesForInvoice,
  liveCreditNoteCountForInvoice,
  markInvoicePaymentsRefundPending,
  updateCustomerBalance
} from '../payments/repository.js';
import { reverseCreditApplicationsForInvoice } from '../payments/service.js';
import { ApiError } from '../../utils/ApiError.js';
import { withTransaction } from '../../utils/transaction.js';
import { createInvoiceRecord, deleteInvoiceRecord } from './repository.js';

const invoiceHasStockMovements = (businessId, invoiceId, { session } = {}) =>
  StockMovement.exists({ business: businessId, invoice: invoiceId }).session(session || null);

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
        sku: item.sku,
        // Carry the per-item GST identity across, or a mixed-rate invoice would be
        // duplicated at a single flattened rate.
        hsn: item.hsn,
        taxRate: item.taxRate
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

const DELETE_BLOCKED_MESSAGE =
  'This invoice cannot be deleted because it has associated payments or inventory/accounting transactions. Please cancel the invoice instead.';

const refreshCustomerBalanceForInvoice = async (req, invoice, { session } = {}) => {
  if (!invoice.customer) return null;
  const totals = await customerBalanceTotals(req.business._id, invoice.customer, { session });
  return updateCustomerBalance(req.business._id, invoice.customer, totals, { session, actorId: req.user._id });
};

// Compensating ledger entries: mirror each original entry with the opposite
// direction (sourceType 'adjustment'). Originals are preserved for audit; the
// net accounting effect of the document becomes zero.
//
// Shared by invoice cancellation and credit-note cancellation — the entries to
// mirror are looked up by the caller (they hang off different fields), the
// mirroring itself is the same operation for every sales document.
// `note` names the event being compensated, so a credit-application reversal does not
// describe itself as a cancellation.
export const reverseLedgerEntries = (req, document, entries, { session, note = 'cancelled' } = {}) => {
  if (!entries.length) return [];

  const reversedAt = new Date();
  const label = document.documentNumber || document.invoiceNumber;
  const reversals = entries.map((entry) => ({
    business: entry.business,
    customer: entry.customer || null,
    salesDocument: document._id,
    // Keep the original entry's invoice link: a credit note's rows point at the
    // invoice it credits, not at itself.
    invoice: entry.invoice || null,
    payment: entry.payment || null,
    sourceType: 'adjustment',
    sourceId: document._id,
    account: entry.account,
    direction: entry.direction === 'debit' ? 'credit' : 'debit',
    amount: entry.amount,
    currency: entry.currency,
    entryDate: reversedAt,
    description: `Reversal (${label} ${note}): ${entry.description}`,
    createdBy: req.user._id,
    metadata: { reversalOf: entry._id }
  }));

  return createLedgerEntries(reversals, { session });
};

const reverseLedgerForInvoice = async (req, invoice, { session } = {}) =>
  reverseLedgerEntries(req, invoice, await ledgerEntriesForInvoice(req.business._id, invoice._id, { session }), { session });

// Cancel preserves the invoice (audit) while reversing its business effects:
// restore stock, post compensating ledger entries, and flag any payments as
// refund-pending. Payment records themselves are never deleted or auto-refunded.
export const cancelInvoiceWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const invoice = await getInvoiceForBusiness(req.business._id, req.params.id, { session });

    if (invoice.documentStatus === 'cancelled' || invoice.status === 'cancelled') {
      return invoice;
    }

    // A live credit note against this invoice blocks cancellation (§10.1): the note is a
    // filed GST document referencing this supply, and the credit it holds would be left
    // unbacked. The user's path is explicit — reverse applications, cancel the notes,
    // then cancel the invoice.
    const creditNoteCount = await liveCreditNoteCountForInvoice(req.business._id, invoice._id, { session });
    if (creditNoteCount) {
      throw new ApiError(409, 'Cancel the credit notes raised against this invoice first', {
        code: 'INVOICE_HAS_CREDIT_NOTES',
        creditNoteCount
      });
    }

    invoice.updatedBy = req.user._id;
    // Set documentStatus only — the pre-validate hook derives legacy `status`
    // ('cancelled') from it. paidAmount/balanceDue are left intact so the audit
    // trail shows exactly what was paid before cancellation.
    invoice.documentStatus = 'cancelled';
    invoice.cancelledAt = new Date();
    invoice.cancelledBy = req.user._id;
    // Revoke any public share link so a cancelled invoice can't be sent/viewed
    // through a previously-issued link.
    invoice.shareRevokedAt = new Date();
    if (typeof req.body?.cancelReason === 'string') {
      invoice.cancelReason = req.body.cancelReason.trim().slice(0, 500);
    }

    const movements = await stockAdjustmentsForInvoice(invoice, 1, { session });
    // Credit applied to this invoice goes back to the customer's pool before the rest of
    // the unwind; cash stays put and is flagged for refund below.
    await reverseCreditApplicationsForInvoice(req, invoice, { session });
    await reverseLedgerForInvoice(req, invoice, { session });
    await markInvoicePaymentsRefundPending(req.business._id, invoice._id, { session });
    await invoice.save({ session });
    await refreshCustomerBalanceForInvoice(req, invoice, { session });
    await publishInvoiceCancelledEvent(req, invoice, { session });
    await publishStockAdjustedEvents(req, movements, { session });

    // Cancelling re-renders the PDF (CANCELLED watermark / status) — drop the cache.
    void invalidateInvoicePdf(invoice);

    return invoice;
  });

// Delete = permanent removal, allowed ONLY for draft/unprocessed invoices with
// no payments, no stock movements, and no ledger entries. Anything processed
// must be cancelled instead (preserves the record).
export const assertInvoiceDeletable = async (businessId, invoice, { session } = {}) => {
  if (invoice.documentStatus === 'cancelled' || invoice.status === 'cancelled') {
    throw new ApiError(409, DELETE_BLOCKED_MESSAGE, { code: 'INVOICE_NOT_DELETABLE' });
  }
  const [hasPayments, hasStock, hasLedger, creditNoteCount] = await Promise.all([
    invoiceHasPayments(businessId, invoice._id, { session }),
    invoiceHasStockMovements(businessId, invoice._id, { session }),
    invoiceHasLedgerEntries(businessId, invoice._id, { session }),
    liveCreditNoteCountForInvoice(businessId, invoice._id, { session })
  ]);
  // In practice a creditable invoice always has ledger entries, so the credit-note check
  // is belt and braces — but deleting the invoice a live note references would leave that
  // note pointing at nothing.
  if (hasPayments || hasStock || hasLedger || creditNoteCount) {
    throw new ApiError(409, DELETE_BLOCKED_MESSAGE, { code: 'INVOICE_NOT_DELETABLE' });
  }
};

export const deleteInvoiceWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const invoice = await getInvoiceForBusiness(req.business._id, req.params.id, { session });

    await assertInvoiceDeletable(req.business._id, invoice, { session });

    invoice.updatedBy = req.user._id;
    // No stock movements / ledger entries exist (guard above), so nothing to
    // reverse — just remove the record and refresh derived balances.
    await publishInvoiceCancelledEvent(req, invoice, { session, suffix: 'deleted' });
    await deleteInvoiceRecord(invoice, { userId: req.user._id, session });
    await refreshCustomerBalanceForInvoice(req, invoice, { session });

    // Document gone — purge any cached PDF.
    void invalidateInvoicePdf(invoice);

    return invoice;
  });

// Action eligibility surfaced to the client so the UI can enable/disable the
// Cancel and Delete buttons authoritatively (the workflows still re-check).
export const computeInvoiceEligibility = async (businessId, invoice, { session } = {}) => {
  const isCancelled = invoice.documentStatus === 'cancelled' || invoice.status === 'cancelled';
  const [hasPayments, hasStock, hasLedger, creditNoteCount] = await Promise.all([
    invoiceHasPayments(businessId, invoice._id, { session }),
    invoiceHasStockMovements(businessId, invoice._id, { session }),
    invoiceHasLedgerEntries(businessId, invoice._id, { session }),
    liveCreditNoteCountForInvoice(businessId, invoice._id, { session })
  ]);
  // A live credit note blocks both cancel and delete (§10.1, and assertInvoiceDeletable),
  // so both flags have to say so — a client that offers an action the workflow refuses is
  // worse than one that offers none.
  const hasCreditNotes = creditNoteCount > 0;
  return {
    hasPayments: Boolean(hasPayments),
    hasStockMovements: Boolean(hasStock),
    hasLedgerEntries: Boolean(hasLedger),
    hasCreditNotes,
    canCancel: !isCancelled && invoice.documentStatus !== 'void' && !hasCreditNotes,
    canDelete: !isCancelled && invoice.documentStatus !== 'void' && !hasPayments && !hasStock && !hasLedger && !hasCreditNotes
  };
};
