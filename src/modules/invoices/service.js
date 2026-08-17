import { buildInvoicePayload, getInvoiceForBusiness, setInvoicePdfUrl, stockAdjustmentsForInvoice } from '../../services/invoiceService.js';
import { invalidateInvoicePdf } from '../../services/invoicePdfCache.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../../services/eventBus.js';
import StockMovement from '../../models/StockMovement.js';
import {
  closeInvoiceForCancellation,
  createLedgerEntries,
  customerBalanceTotals,
  invoiceHasLedgerEntries,
  invoiceHasPayments,
  ledgerEntriesForInvoice,
  liveAllocationsForInvoice,
  liveCreditNoteCountForInvoice,
  markInvoicePaymentsRefundPending,
  reopenCancelledInvoice,
  updateCustomerBalance,
  withdrawUnappliedCreditForInvoice
} from '../payments/repository.js';
import { refundCrossInvoiceAllocationsForInvoice, reverseCreditApplicationsForInvoice } from '../payments/service.js';
import { ApiError } from '../../utils/ApiError.js';
import { withTransaction } from '../../utils/transaction.js';
import { createInvoiceRecord, deleteInvoiceRecord } from './repository.js';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

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

/**
 * Compensate the invoice's own ledger rows on cancellation.
 *
 * Every row is mirrored at its original amount except two, both of which belong to a receipt
 * as a whole rather than to this invoice alone:
 *
 * - `customer_credits` is mirrored only for the credit this cancellation actually withdrew
 *   (`withdrawn`, keyed by payment). Credit already spent on another invoice was discharged
 *   by that application's own debit; mirroring the full original row as well would compensate
 *   the same liability twice, drive the account negative, and leave the ledger disagreeing
 *   with `availableCredit` by the amount already spent.
 * - the cash/bank debit is mirrored only for this invoice's share of the receipt: what it
 *   still holds as a live allocation plus what was just withdrawn from the same receipt. A
 *   receipt that settled several invoices posts ONE cash debit for the whole amount, so
 *   mirroring it in full would say cash still settling other, live invoices had gone back out.
 *   For a single-invoice receipt the share is the whole row, so nothing changes there.
 */
const CASH_ACCOUNTS = new Set(['cash', 'bank']);

const reverseLedgerForInvoice = async (req, invoice, withdrawn = new Map(), { session } = {}) => {
  const entries = await ledgerEntriesForInvoice(req.business._id, invoice._id, { session });
  const remaining = new Map(withdrawn);

  const allocations = await liveAllocationsForInvoice(req.business._id, invoice._id, { session });
  const cashShare = new Map(withdrawn);
  for (const allocation of allocations) {
    if (allocation.source !== 'payment' || !allocation.payment) continue;
    const key = String(allocation.payment);
    cashShare.set(key, money(money(cashShare.get(key)) + money(allocation.amount)));
  }

  // Mirror at most `left` of this row, tracking what is still owed per receipt.
  const bounded = (budget, entry) => {
    const key = String(entry.payment || '');
    const left = money(budget.get(key));
    const amount = money(Math.min(money(entry.amount), left));
    if (amount <= 0) return null;
    budget.set(key, money(left - amount));
    return amount === money(entry.amount) ? entry : { ...entry, amount };
  };

  const compensated = [];
  for (const entry of entries) {
    if (entry.account === 'customer_credits') {
      const row = bounded(remaining, entry);
      if (row) compensated.push(row);
      continue;
    }
    if (entry.direction === 'debit' && CASH_ACCOUNTS.has(entry.account)) {
      const row = bounded(cashShare, entry);
      if (row) compensated.push(row);
      continue;
    }
    compensated.push(entry);
  }

  return reverseLedgerEntries(req, invoice, compensated, { session });
};

/**
 * Cancel preserves the invoice (audit) while reversing its business effects: restore stock,
 * post compensating ledger entries, and flag any payments as refund-pending. Payment records
 * themselves are never deleted or auto-refunded.
 *
 * The cancelled status is committed FIRST, in one compare-and-set, before anything is
 * reversed. It used to be mutated in memory and saved at the very end, which meant MongoDB
 * reported the invoice as 'issued' for the whole duration of the unwind — long enough for a
 * concurrent payment, dues collection, credit application or credit note to pass its own
 * status guard and land on an invoice that was already being cancelled. Closing the document
 * up front is what makes those guards mean something without a transaction to serialise them.
 */
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

    // What to put back if a guard that can only be evaluated after the transition refuses.
    const before = {
      documentStatus: invoice.documentStatus,
      status: invoice.status,
      cancelledAt: invoice.cancelledAt,
      cancelledBy: invoice.cancelledBy,
      shareRevokedAt: invoice.shareRevokedAt,
      cancelReason: invoice.cancelReason,
      updatedBy: req.user._id
    };

    const cancelledAt = new Date();
    // `status` is written explicitly: the pre-validate hook that derives it from
    // documentStatus does not run on a query-path update. paidAmount/balanceDue are left
    // intact so the audit trail shows exactly what was paid before cancellation, and the
    // share link is revoked so a cancelled invoice cannot be viewed through it.
    const cancelled = await closeInvoiceForCancellation(
      req.business._id,
      invoice._id,
      {
        documentStatus: 'cancelled',
        status: 'cancelled',
        cancelledAt,
        cancelledBy: req.user._id,
        shareRevokedAt: cancelledAt,
        updatedBy: req.user._id,
        ...(typeof req.body?.cancelReason === 'string'
          ? { cancelReason: req.body.cancelReason.trim().slice(0, 500) }
          : {})
      },
      { session }
    );
    // Lost the race to a concurrent cancellation — idempotent, same as the check above.
    if (!cancelled) return getInvoiceForBusiness(req.business._id, req.params.id, { session });

    // A credit note raised in the same instant would have passed its own `documentStatus:
    // 'issued'` claim just before the transition landed. Re-checking after it is what makes
    // the two decisions ordered; the note wins and the cancellation is put back.
    const racedCreditNotes = await liveCreditNoteCountForInvoice(req.business._id, invoice._id, { session });
    if (racedCreditNotes) {
      await reopenCancelledInvoice(req.business._id, invoice._id, before, { session });
      throw new ApiError(409, 'Cancel the credit notes raised against this invoice first', {
        code: 'INVOICE_HAS_CREDIT_NOTES',
        creditNoteCount: racedCreditNotes
      });
    }

    const movements = await stockAdjustmentsForInvoice(cancelled, 1, { session });

    // ponytail: bounded sweep, three passes. No new settlement can pass the status predicate
    // now, so the only rows that can still appear are from workflows that claimed capacity
    // before the transition committed and are writing their allocation right now. Under a
    // real transaction the write conflict on this document removes the window entirely; this
    // is what covers the no-session fallback. Upgrade path if it ever proves too narrow: a
    // dedicated in-flight counter on the invoice, claimed and released alongside capacity.
    for (let pass = 0; pass < 3; pass += 1) {
      // Credit applied to this invoice goes back to the customer's pool.
      const reversed = await reverseCreditApplicationsForInvoice(req, cancelled, { session });
      // Cash that reached this invoice through a receipt booked against another invoice
      // becomes refundable on that receipt — without this it would settle nothing, be
      // spendable nowhere, and simply disappear.
      const refunded = await refundCrossInvoiceAllocationsForInvoice(req, cancelled, { session });
      if (!reversed && !refunded.length) break;
    }

    // Credit this invoice's own receipts still hold stops being spendable and becomes cash
    // owed back, so the same money is never both applicable credit and a pending refund.
    // Runs before the ledger unwind because the compensating `customer_credits` entry is
    // bounded by exactly what was withdrawn here, and before the refund flag because both
    // select the same receipts.
    const withdrawn = await withdrawUnappliedCreditForInvoice(req.business._id, cancelled._id, { session });
    await reverseLedgerForInvoice(req, cancelled, withdrawn, { session });
    await markInvoicePaymentsRefundPending(req.business._id, cancelled._id, { session });
    await refreshCustomerBalanceForInvoice(req, cancelled, { session });
    await publishInvoiceCancelledEvent(req, cancelled, { session });
    await publishStockAdjustedEvents(req, movements, { session });

    // Cancelling re-renders the PDF (CANCELLED watermark / status) — drop the cache.
    void invalidateInvoicePdf(cancelled);

    return cancelled;
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
