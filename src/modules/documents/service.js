import Invoice from '../../models/Invoice.js';
import { ApiError } from '../../utils/ApiError.js';
import { withTransaction } from '../../utils/transaction.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../../services/eventBus.js';
import {
  buildSalesDocumentPayload,
  setInvoicePdfUrl,
  stockAdjustmentsForInvoice
} from '../../services/invoiceService.js';
import { createInvoiceRecord } from '../invoices/repository.js';
import { publishInvoiceIssuedEvent, publishStockAdjustedEvents } from '../invoices/service.js';
import { createLedgerEntries, customerBalanceTotals, updateCustomerBalance } from '../payments/repository.js';
import { rulesFor } from './documentTypes.js';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const getDocumentForBusiness = async (businessId, documentId, documentType, { session } = {}) => {
  const filter = { _id: documentId, business: businessId, ...(documentType ? { documentType } : {}) };
  const document = await Invoice.findOne(filter).session(session || null);

  if (!document) throw new ApiError(404, 'Document not found');
  return document;
};

/**
 * A credit note may not exceed what the invoice was actually worth, after any earlier
 * credit notes. Over-crediting would hand the customer more back than they ever paid and
 * would file a negative supply in GSTR-1.
 */
const assertCreditNoteWithinInvoice = async (businessId, invoice, amount, { session } = {}) => {
  const existing = await Invoice.aggregate([
    { $match: { business: businessId, documentType: 'credit_note', sourceInvoice: invoice._id, documentStatus: 'issued' } },
    { $group: { _id: null, total: { $sum: '$total' } } }
  ]).session(session || null);

  const alreadyCredited = money(existing[0]?.total || 0);
  const remaining = money(Number(invoice.total || 0) - alreadyCredited);

  if (money(amount) > remaining) {
    throw new ApiError(409, `Credit note exceeds the invoice. At most ${remaining} can still be credited.`, {
      code: 'CREDIT_NOTE_EXCEEDS_INVOICE',
      invoiceTotal: money(invoice.total),
      alreadyCredited,
      remaining
    });
  }
};

/**
 * Ledger entries for a credit note: the mirror image of an invoice's own posting.
 * Revenue is debited back and the customer's receivable is credited, so the net effect of
 * invoice + full credit note is zero — the same compensating-entry approach cancellation
 * uses, rather than editing or deleting the original rows.
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
        account: 'accounts_receivable',
        direction: 'credit',
        amount: money(creditNote.total),
        currency: 'INR',
        entryDate: creditNote.date || new Date(),
        description: `Credit note ${creditNote.documentNumber} receivable reversal`,
        createdBy: req.user._id
      }
    ],
    { session }
  );

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
      await assertCreditNoteWithinInvoice(req.business._id, sourceInvoice, payload.total, { session });
    }

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
      if (document.customer) {
        const totals = await customerBalanceTotals(req.business._id, document.customer, { session });
        await updateCustomerBalance(req.business._id, document.customer, totals, { session, actorId: req.user._id });
      }
    }

    await publishInvoiceIssuedEvent(req, document, { session, suffix: documentType });
    if (movements.length) await publishStockAdjustedEvents(req, movements, { session });

    return document;
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
    const existing = await Invoice.findOne({
      business: req.business._id,
      documentType: 'invoice',
      sourceDocument: source._id
    }).session(session || null);

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

    document.documentStatus = 'cancelled';
    document.cancelledAt = new Date();
    document.cancelledBy = req.user._id;
    document.shareRevokedAt = new Date();
    document.updatedBy = req.user._id;
    if (typeof req.body?.cancelReason === 'string') {
      document.cancelReason = req.body.cancelReason.trim().slice(0, 500);
    }

    // Put back whatever the document moved when it was issued.
    const movements =
      rules.stockDirection === 0 ? [] : await stockAdjustmentsForInvoice(document, -rules.stockDirection, { session });

    await document.save({ session });
    await publishDomainEvent(
      {
        business: req.business._id,
        actor: req.user._id,
        eventType: DOMAIN_EVENTS.documentCancelled,
        aggregateType: 'sales_document',
        aggregateId: document._id,
        payload: {
          documentType,
          documentNumber: document.documentNumber,
          customerId: document.customer,
          customerName: document.customerSnapshot?.name,
          total: document.total
        },
        dedupeKey: `${DOMAIN_EVENTS.documentCancelled}:${document._id}:cancelled`
      },
      { session }
    );
    if (movements.length) await publishStockAdjustedEvents(req, movements, { session });

    return document;
  });
};
