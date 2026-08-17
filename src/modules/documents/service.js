import Invoice from '../../models/Invoice.js';
import StockMovement from '../../models/StockMovement.js';
import { ApiError } from '../../utils/ApiError.js';
import { withTransaction } from '../../utils/transaction.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../../services/eventBus.js';
import {
  buildSalesDocumentPayload,
  setInvoicePdfUrl,
  stockAdjustmentsForInvoice
} from '../../services/invoiceService.js';
import { createInvoiceRecord } from '../invoices/repository.js';
import { publishInvoiceIssuedEvent, publishStockAdjustedEvents, reverseLedgerEntries } from '../invoices/service.js';
import {
  applicationsForCreditNote,
  claimCreditOnInvoice,
  closeCreditNoteForCancellation,
  createLedgerEntries,
  customerBalanceTotals,
  ledgerEntriesForCreditNote,
  releaseCreditOnInvoice,
  reopenCancelledCreditNote,
  updateCustomerBalance
} from '../payments/repository.js';
import { rulesFor } from './documentTypes.js';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const getDocumentForBusiness = async (businessId, documentId, documentType, { session } = {}) => {
  const filter = { _id: documentId, business: businessId, ...(documentType ? { documentType } : {}) };
  const document = await Invoice.findOne(filter).session(session || null);

  if (!document) throw new ApiError(404, 'Document not found');
  return document;
};

/**
 * The invoice a quotation or challan was converted into, if any. Mirrors findInvoiceForOrder:
 * the link already exists on the invoice (sourceDocument), this only makes it readable from
 * the source side. Scoped to the business, so it can never reach another tenant's invoice.
 */
export const findInvoiceForDocument = (businessId, documentId, { session } = {}) =>
  Invoice.findOne({ business: businessId, documentType: 'invoice', sourceDocument: documentId })
    .select('invoiceNumber documentNumber status date')
    .session(session || null);

/**
 * What this document actually did to stock, read from the movements it wrote rather than
 * inferred from the rules table. The difference is real: a line only moves stock when it
 * points at a product that is not `trackStock: false`, so a challan of custom lines moves
 * nothing at all and a UI that reads the rules row alone would claim otherwise.
 *
 * `sale` rows are the deduction, `sale_cancelled` rows the reversal cancellation wrote —
 * the same two types stockAdjustmentsForInvoice records for every sales document.
 */
export const stockEffectForDocument = async (businessId, documentId, { session } = {}) => {
  const rows = await StockMovement.aggregate([
    { $match: { business: businessId, salesDocument: documentId } },
    { $group: { _id: '$type', products: { $addToSet: '$product' }, quantity: { $sum: '$quantityChange' } } }
  ]).session(session || null);

  const deducted = rows.find((row) => row._id === 'sale');
  const restored = rows.find((row) => row._id === 'sale_cancelled');

  return {
    products: deducted?.products.length || 0,
    quantity: Math.abs(deducted?.quantity || 0),
    reversed: Boolean(restored)
  };
};

/**
 * A credit note may not exceed what the invoice was actually worth, after any earlier
 * credit notes. Over-crediting would hand the customer more back than they ever paid and
 * would file a negative supply in GSTR-1.
 *
 * The room is claimed on the invoice's own `creditedAmount` counter with a compare-and-set,
 * not checked with an aggregate first: an aggregate-then-insert leaves a window in which two
 * concurrent notes both read the same "already credited" figure and both pass.
 */
const claimCreditNoteRoomOnInvoice = async (businessId, invoice, amount, { session } = {}) => {
  const claimed = await claimCreditOnInvoice(businessId, invoice, amount, { session });
  if (claimed) return claimed;

  // Only to describe the failure — the decision was already made by the update above.
  const current = await Invoice.findOne({ _id: invoice._id, business: businessId }).select('total creditedAmount').lean();
  const alreadyCredited = money(current?.creditedAmount || 0);
  const remaining = money(money(current?.total || invoice.total) - alreadyCredited);

  throw new ApiError(409, `Credit note exceeds the invoice. At most ${remaining} can still be credited.`, {
    code: 'CREDIT_NOTE_EXCEEDS_INVOICE',
    invoiceTotal: money(invoice.total),
    alreadyCredited,
    remaining
  });
};

/**
 * Ledger entries for a credit note: revenue is debited back, and the value returned to the
 * customer is booked as a liability on `customer_credits` — the same account an overpayment
 * already credits.
 *
 * It does NOT credit `accounts_receivable`. Until the credit is explicitly applied the
 * customer still owes the invoice in full and the business separately owes them the credit,
 * which is exactly what these two rows say. Crediting the receivable here would assert the
 * debt was settled and would disagree with the balance formula by the credit amount.
 */
const postCreditNoteLedger = (req, creditNote, sourceInvoiceNumber, { session } = {}) =>
  createLedgerEntries(
    [
      {
        business: req.business._id,
        customer: creditNote.customer || null,
        salesDocument: creditNote._id,
        invoice: creditNote.sourceInvoice || null,
        sourceType: 'credit_note',
        sourceId: creditNote._id,
        account: 'sales',
        direction: 'debit',
        amount: money(creditNote.total),
        currency: 'INR',
        entryDate: creditNote.date || new Date(),
        description: `Credit note ${creditNote.documentNumber} against invoice ${sourceInvoiceNumber || ''}`.trim(),
        createdBy: req.user._id
      },
      {
        business: req.business._id,
        customer: creditNote.customer || null,
        salesDocument: creditNote._id,
        invoice: creditNote.sourceInvoice || null,
        sourceType: 'credit_note',
        sourceId: creditNote._id,
        account: 'customer_credits',
        direction: 'credit',
        amount: money(creditNote.total),
        currency: 'INR',
        entryDate: creditNote.date || new Date(),
        description: `Customer credit from credit note ${creditNote.documentNumber}`,
        createdBy: req.user._id
      }
    ],
    { session }
  );

/**
 * Recomputes the customer's outstanding/credit from source. customerBalanceTotals
 * already ignores cancelled and void documents, so the same call both applies a
 * newly issued credit note and takes a cancelled one back off the books.
 * A counter/cash sale has no Customer record, so there is nothing to refresh.
 */
const refreshCustomerBalanceForDocument = async (req, document, { session } = {}) => {
  if (!document.customer) return null;
  const totals = await customerBalanceTotals(req.business._id, document.customer, { session });
  return updateCustomerBalance(req.business._id, document.customer, totals, { session, actorId: req.user._id });
};

/**
 * Creates a quotation, delivery challan or credit note.
 *
 * Every per-type difference comes from the rules table: which number series to draw from,
 * whether stock moves and in which direction, and whether anything is posted to the ledger.
 */
export const createDocumentWorkflow = ({ req, documentType }) => {
  const rules = rulesFor(documentType);
  if (!rules) throw new ApiError(422, 'Unsupported document type');

  return withTransaction(async (session) => {
    let sourceInvoice = null;

    if (rules.sourceField === 'sourceInvoice') {
      if (!req.body.sourceInvoiceId) {
        throw new ApiError(422, 'A credit note must be raised against an invoice');
      }
      sourceInvoice = await getDocumentForBusiness(req.business._id, req.body.sourceInvoiceId, 'invoice', { session });

      if (sourceInvoice.documentStatus !== 'issued') {
        throw new ApiError(409, 'Only an issued invoice can be credited', { code: 'INVOICE_NOT_CREDITABLE' });
      }
    }

    const payload = await buildSalesDocumentPayload(
      req.user,
      req.business,
      {
        ...req.body,
        // Credit notes and challans never carry a payment status of their own.
        status: 'pending',
        sourceInvoice: sourceInvoice?._id || null,
        // A credit note inherits the original supply's place of supply: the reversal must
        // file against the same state as the sale it undoes.
        placeOfSupplyCode: sourceInvoice?.placeOfSupply?.code || req.body.placeOfSupplyCode
      },
      { session, documentType }
    );

    if (sourceInvoice) {
      await claimCreditNoteRoomOnInvoice(req.business._id, sourceInvoice, payload.total, { session });
    }

    try {
      const document = await createInvoiceRecord(payload, { session });
      await setInvoicePdfUrl(document, req, { session });

      let movements = [];
      if (rules.stockDirection !== 0) {
        movements = await stockAdjustmentsForInvoice(document, rules.stockDirection, {
          session,
          allowOversell: Boolean(req.body.allowOversell)
        });
      }

      if (rules.postsLedger) {
        await postCreditNoteLedger(req, document, sourceInvoice?.invoiceNumber, { session });
        await refreshCustomerBalanceForDocument(req, document, { session });
      }

      await publishInvoiceIssuedEvent(req, document, { session, suffix: documentType });
      if (movements.length) await publishStockAdjustedEvents(req, movements, { session });

      return document;
    } catch (error) {
      // With a transaction the claim rolls back with everything else. Without one (the dev
      // fallback) it has already committed, so the room must be handed back explicitly or
      // the invoice stays permanently short of credit room it never granted.
      if (!session && sourceInvoice) {
        await releaseCreditOnInvoice(req.business._id, sourceInvoice._id, payload.total).catch(() => null);
      }
      throw error;
    }
  });
};

/**
 * Turns a quotation (or challan) into an invoice, once.
 *
 * Mirrors generateInvoiceForOrderWorkflow: the invoice is rebuilt from the source
 * document's own items so totals match exactly, the link is recorded on both sides, and a
 * second attempt returns a conflict rather than a duplicate invoice.
 */
export const convertDocumentWorkflow = ({ req, documentType }) => {
  const rules = rulesFor(documentType);
  if (!rules?.convertsTo) throw new ApiError(422, `A ${rules?.label || documentType} cannot be converted`);

  return withTransaction(async (session) => {
    const source = await getDocumentForBusiness(req.business._id, req.params.id, documentType, { session });

    // Checked before the status guard: converting sets the source to 'void', so a second
    // attempt must report "already invoiced" (with the invoice to look at) rather than the
    // misleading "cancelled".
    const existing = await findInvoiceForDocument(req.business._id, source._id, { session });

    if (existing) {
      throw new ApiError(409, `This ${rules.label.toLowerCase()} has already been invoiced`, {
        code: 'DOCUMENT_ALREADY_INVOICED',
        invoiceId: existing._id,
        invoiceNumber: existing.invoiceNumber
      });
    }

    if (source.documentStatus === 'cancelled' || source.documentStatus === 'void') {
      throw new ApiError(409, `A cancelled ${rules.label.toLowerCase()} cannot be converted`, { code: 'DOCUMENT_CANCELLED' });
    }

    const payload = await buildSalesDocumentPayload(
      req.user,
      req.business,
      {
        customerId: source.customer || undefined,
        customer: source.customer ? undefined : source.customerSnapshot,
        items: source.items.map((item) => ({
          productId: item.product || undefined,
          name: item.name,
          sku: item.sku,
          hsn: item.hsn,
          taxRate: item.taxRate,
          quantity: item.quantity,
          price: item.price
        })),
        taxRate: source.tax?.rate,
        discountType: source.discount?.type,
        discountValue: source.discount?.value,
        status: 'pending',
        notes: source.notes,
        placeOfSupplyCode: source.placeOfSupply?.code,
        allowOversell: Boolean(req.body?.allowOversell)
      },
      { session, documentType: 'invoice' }
    );
    payload.sourceDocument = source._id;

    const invoice = await createInvoiceRecord(payload, { session });
    await setInvoicePdfUrl(invoice, req, { session });

    // A challan already moved the stock when the goods left; invoicing it must not deduct
    // the same units twice.
    const alreadyMovedStock = rules.stockDirection === -1;
    const movements = alreadyMovedStock
      ? []
      : await stockAdjustmentsForInvoice(invoice, -1, { session, allowOversell: Boolean(req.body?.allowOversell) });

    source.documentStatus = 'void';
    source.updatedBy = req.user._id;
    await source.save({ session });

    await publishInvoiceIssuedEvent(req, invoice, { session, suffix: `${documentType}:${source._id}` });
    if (movements.length) await publishStockAdjustedEvents(req, movements, { session });

    return invoice;
  });
};

export const cancelDocumentWorkflow = ({ req, documentType }) => {
  const rules = rulesFor(documentType);

  return withTransaction(async (session) => {
    const document = await getDocumentForBusiness(req.business._id, req.params.id, documentType, { session });

    if (document.documentStatus === 'cancelled') return document;
    if (document.documentStatus === 'void') {
      throw new ApiError(409, `This ${rules.label.toLowerCase()} was already converted to an invoice`, { code: 'DOCUMENT_CONVERTED' });
    }

    const cancelledAt = new Date();
    const patch = {
      documentStatus: 'cancelled',
      status: 'cancelled', // explicit: a query-path update skips pre('validate'), which is what derives this normally
      cancelledAt,
      cancelledBy: req.user._id,
      shareRevokedAt: cancelledAt,
      updatedBy: req.user._id,
      ...(typeof req.body?.cancelReason === 'string' ? { cancelReason: req.body.cancelReason.trim().slice(0, 500) } : {})
    };

    let cancelled;
    if (documentType === 'credit_note') {
      // Atomic close-first (§F-1, mirrors cancelInvoiceWorkflow): the "no live application"
      // guard (§9) and the status transition are ONE compare-and-set, keyed on the same
      // appliedAmount counter claimCreditFromNote claims. The old read-appliedAmount-then-save
      // ordering left a window where a concurrent application could claim credit from a note
      // that was mid-cancellation, or vice versa. See closeCreditNoteForCancellation.
      cancelled = await closeCreditNoteForCancellation(req.business._id, document._id, patch, { session });

      if (!cancelled) {
        // Lost the race, or a live application blocks cancellation — re-read from the
        // database, never the stale `document`, to tell an idempotent no-op from the 409.
        const fresh = await getDocumentForBusiness(req.business._id, document._id, documentType, { session });
        if (fresh.documentStatus === 'cancelled') return fresh;
        if (fresh.documentStatus === 'void') {
          throw new ApiError(409, `This ${rules.label.toLowerCase()} was already converted to an invoice`, {
            code: 'DOCUMENT_CONVERTED'
          });
        }

        const applications = await applicationsForCreditNote(req.business._id, fresh._id, { session });
        throw new ApiError(409, 'Reverse the credit applied from this note before cancelling it', {
          code: 'CREDIT_NOTE_HAS_APPLICATIONS',
          total: money(fresh.total),
          appliedAmount: money(fresh.appliedAmount),
          remaining: money(money(fresh.total) - money(fresh.appliedAmount)),
          applications: applications.map((application) => ({
            invoiceNumber: application.invoice?.invoiceNumber || application.invoice?.documentNumber || '',
            amount: application.amount
          }))
        });
      }

      // Belt-and-braces: appliedAmount was 0 the instant the transition landed, and
      // claimCreditFromNote always claims that same counter before writing an allocation —
      // so no live application can exist now. If this ever fires, the invariant above broke;
      // treat it as the race it would be rather than ship a cancelled note still being consumed.
      const stranded = await applicationsForCreditNote(req.business._id, cancelled._id, { session });
      if (stranded.length) {
        await reopenCancelledCreditNote(
          req.business._id,
          cancelled._id,
          {
            documentStatus: document.documentStatus,
            status: document.status,
            cancelledAt: document.cancelledAt,
            cancelledBy: document.cancelledBy,
            shareRevokedAt: document.shareRevokedAt,
            cancelReason: document.cancelReason,
            updatedBy: req.user._id
          },
          { session }
        );
        throw new ApiError(409, 'Reverse the credit applied from this note before cancelling it', {
          code: 'CREDIT_NOTE_HAS_APPLICATIONS'
        });
      }
    } else {
      Object.assign(document, patch);
      cancelled = document;
    }

    // Put back whatever the document moved when it was issued.
    const movements =
      rules.stockDirection === 0 ? [] : await stockAdjustmentsForInvoice(cancelled, -rules.stockDirection, { session });

    // A credit note posted ledger rows and moved the customer's balance when it was issued;
    // cancelling has to undo both, or the customer keeps a credit the note no longer grants.
    // Compensating entries (never deletes), exactly as an invoice cancellation does. Read
    // after the status transition already committed, so this only ever sees the note's own
    // original rows, never a concurrent reversal's.
    const ledgerEntries = rules.postsLedger
      ? await ledgerEntriesForCreditNote(req.business._id, cancelled._id, { session })
      : [];

    if (documentType !== 'credit_note') await cancelled.save({ session });

    // A cancelled note no longer credits its source invoice, so the room it claimed goes
    // back — otherwise the invoice could never be credited for that value again.
    if (documentType === 'credit_note' && cancelled.sourceInvoice) {
      await releaseCreditOnInvoice(req.business._id, cancelled.sourceInvoice, cancelled.total, { session });
    }

    if (ledgerEntries.length) await reverseLedgerEntries(req, cancelled, ledgerEntries, { session });
    if (rules.postsLedger) await refreshCustomerBalanceForDocument(req, cancelled, { session });

    await publishDomainEvent(
      {
        business: req.business._id,
        actor: req.user._id,
        eventType: DOMAIN_EVENTS.documentCancelled,
        aggregateType: 'sales_document',
        aggregateId: cancelled._id,
        payload: {
          documentType,
          documentNumber: cancelled.documentNumber,
          customerId: cancelled.customer,
          customerName: cancelled.customerSnapshot?.name,
          total: cancelled.total
        },
        dedupeKey: `${DOMAIN_EVENTS.documentCancelled}:${cancelled._id}:cancelled`
      },
      { session }
    );
    if (movements.length) await publishStockAdjustedEvents(req, movements, { session });

    return cancelled;
  });
};
