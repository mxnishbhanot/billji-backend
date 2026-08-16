import Customer from '../../models/Customer.js';
import CustomerBalance from '../../models/CustomerBalance.js';
import Invoice from '../../models/Invoice.js';
import LedgerEntry from '../../models/LedgerEntry.js';
import Payment from '../../models/Payment.js';
import SettlementAllocation from '../../models/SettlementAllocation.js';

export const createPaymentRecord = async (payload, { session } = {}) => {
  const [payment] = await Payment.create([payload], { session });
  return payment;
};

export const createSettlementAllocation = async (payload, { session } = {}) => {
  const [allocation] = await SettlementAllocation.create([payload], { session });
  return allocation;
};

export const createLedgerEntries = (entries, { session } = {}) => LedgerEntry.create(entries, { session, ordered: true });

// Original (non-reversal) ledger entries booked for an invoice — used to build
// compensating reversal entries on cancel. Excludes prior 'adjustment' reversals, and
// excludes credit-application pairs (stamped with `metadata.allocationId`): those are
// reversed through the allocation that owns them, and would otherwise be compensated twice.
export const ledgerEntriesForInvoice = (businessId, invoiceId, { session } = {}) =>
  LedgerEntry.find({
    business: businessId,
    invoice: invoiceId,
    sourceType: { $in: ['invoice', 'payment'] },
    'metadata.allocationId': { $exists: false }
  })
    .session(session || null)
    .lean();

// Original (non-reversal) ledger entries booked by a credit note. Keyed on
// salesDocument, not invoice: a credit note's rows carry the *source invoice* in
// `invoice`, so an invoice-keyed lookup would sweep up the invoice's own rows.
// Excludes 'adjustment', so a reversal is never itself reversed.
export const ledgerEntriesForCreditNote = (businessId, documentId, { session } = {}) =>
  LedgerEntry.find({ business: businessId, salesDocument: documentId, sourceType: 'credit_note' })
    .session(session || null)
    .lean();

export const invoiceHasLedgerEntries = (businessId, invoiceId, { session } = {}) =>
  LedgerEntry.exists({ business: businessId, invoice: invoiceId }).session(session || null);

// Flag receipts recorded against this invoice as refund-pending. Scoped to
// single-invoice payments (`invoice` field); multi-invoice settlements are left
// untouched since they remain valid against their other allocations.
export const markInvoicePaymentsRefundPending = (businessId, invoiceId, { session } = {}) =>
  Payment.updateMany(
    { business: businessId, invoice: invoiceId, type: 'receipt', status: 'completed', refundStatus: { $ne: 'pending' } },
    { $set: { refundStatus: 'pending' } },
    { session }
  );

// Move this invoice's refund-pending receipts to 'processed' (the "Refunded
// manually" action). Flag-only: cancel already reversed the ledger and dropped
// the allocation from the customer balance, so no money is moved here. Returns
// the number of payments flipped.
export const markInvoiceRefundProcessed = async (businessId, invoiceId, actorId, { session } = {}) => {
  const result = await Payment.updateMany(
    { business: businessId, invoice: invoiceId, refundStatus: 'pending' },
    { $set: { refundStatus: 'processed', refundedAt: new Date(), refundedBy: actorId, updatedBy: actorId } },
    { session }
  );
  return result.modifiedCount ?? result.nModified ?? 0;
};

// Any money touched this invoice — direct payment OR an allocation from a
// multi-invoice payment whose own `invoice` field points elsewhere.
export const invoiceHasPayments = async (businessId, invoiceId, { session } = {}) => {
  const [direct, allocated] = await Promise.all([
    Payment.exists({ business: businessId, invoice: invoiceId }).session(session || null),
    SettlementAllocation.exists({ business: businessId, invoice: invoiceId }).session(session || null)
  ]);
  return Boolean(direct || allocated);
};

// What has settled this invoice, split by funding source. `paidAmount` is money that
// actually arrived; `creditApplied` is customer credit spent. Their sum is the single
// settlement figure `balanceDue` is derived from. Reversed rows never count.
export const allocationTotalsForInvoice = async (businessId, invoiceId, { session } = {}) => {
  const rows = await SettlementAllocation.aggregate([
    { $match: { business: businessId, invoice: invoiceId, reversedAt: null } },
    { $group: { _id: '$source', total: { $sum: '$amount' } } }
  ]).session(session || null);

  const bySource = (source) => rows.find((row) => row._id === source)?.total || 0;
  const paidAmount = bySource('payment');
  const creditApplied = bySource('credit_note');

  return { paidAmount, creditApplied, total: paidAmount + creditApplied };
};

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Compare-and-set claims on a counter held by a single document.
 *
 * Every one of these is one `findOneAndUpdate`: the check and the write are a single
 * server-side operation, so two concurrent claims are applied serially and the second
 * re-evaluates the predicate against the first's result. `null` back means "someone else
 * took it" — a 409, never a retry-with-a-read.
 *
 * The predicates are written as plain comparisons against a ceiling computed before the
 * write (`appliedAmount <= total - amount` rather than `appliedAmount + amount <= total`),
 * so no `$expr` is needed and the filter stays index-eligible.
 *
 * This is the same shape the stock guard uses, and like it, the safety property comes from
 * single-document atomicity — it holds whether or not a transaction session is passed,
 * which matters because the dev fallback runs without one.
 */

// Claim room on an invoice for a new credit note. `total` on an issued invoice is
// immutable, so the ceiling is known before the write.
export const claimCreditOnInvoice = async (businessId, invoice, amount, { session } = {}) =>
  Invoice.findOneAndUpdate(
    {
      _id: invoice._id,
      business: businessId,
      documentType: 'invoice',
      documentStatus: 'issued',
      creditedAmount: { $lte: money(money(invoice.total) - money(amount)) }
    },
    { $inc: { creditedAmount: money(amount) } },
    { new: true, session }
  );

// Give the room back: a cancelled credit note no longer credits its source invoice.
export const releaseCreditOnInvoice = (businessId, invoiceId, amount, { session } = {}) =>
  Invoice.findOneAndUpdate(
    { _id: invoiceId, business: businessId, documentType: 'invoice', creditedAmount: { $gte: money(amount) } },
    { $inc: { creditedAmount: -money(amount) } },
    { new: true, session }
  );

// Claim credit off an issued credit note. Ceiling is the note's own immutable total.
export const claimCreditFromNote = async (businessId, creditNote, amount, { session } = {}) =>
  Invoice.findOneAndUpdate(
    {
      _id: creditNote._id,
      business: businessId,
      documentType: 'credit_note',
      documentStatus: 'issued',
      appliedAmount: { $lte: money(money(creditNote.total) - money(amount)) }
    },
    { $inc: { appliedAmount: money(amount) } },
    { new: true, session }
  );

// Claim credit off an overpayment. `unappliedAmount` is the remaining pool itself, so the
// predicate is a direct floor rather than a derived ceiling.
export const claimCreditFromPayment = (businessId, paymentId, amount, { session } = {}) =>
  Payment.findOneAndUpdate(
    { _id: paymentId, business: businessId, status: 'completed', unappliedAmount: { $gte: money(amount) } },
    { $inc: { unappliedAmount: -money(amount), allocatedAmount: money(amount) } },
    { new: true, session }
  );

// Give applied credit back to its note. Mirror of `claimCreditFromNote`; the floor keeps
// `appliedAmount` from going negative if a reversal is somehow replayed.
export const releaseCreditToNote = (businessId, creditNoteId, amount, { session } = {}) =>
  Invoice.findOneAndUpdate(
    { _id: creditNoteId, business: businessId, documentType: 'credit_note', appliedAmount: { $gte: money(amount) } },
    { $inc: { appliedAmount: -money(amount) } },
    { new: true, session }
  );

// Mirror of `claimCreditFromPayment`: the money becomes unapplied credit again.
export const releaseCreditToPayment = (businessId, paymentId, amount, { session } = {}) =>
  Payment.findOneAndUpdate(
    { _id: paymentId, business: businessId, allocatedAmount: { $gte: money(amount) } },
    { $inc: { allocatedAmount: -money(amount), unappliedAmount: money(amount) } },
    { new: true, session }
  );

/**
 * A customer's credit pool as one FIFO-ordered list (§7): issued credit notes with room
 * left, plus completed payments with money parked. Ordered by `(sourceDate, _id)` so the
 * oldest credit is consumed first and the order is stable when two rows share a date.
 *
 * `applied` is derived, not a field: for a note it is `appliedAmount`, for a payment it is
 * everything of that receipt already settling invoices — including the invoice it was
 * received against. Both mean "no longer available", which is what the caller needs.
 */
export const creditSourcesForCustomer = async (businessId, customerId, { session } = {}) => {
  const [notes, payments] = await Promise.all([
    Invoice.find({
      business: businessId,
      documentType: 'credit_note',
      customer: customerId,
      documentStatus: { $nin: ['cancelled', 'void'] }
    })
      .select('documentNumber date total appliedAmount')
      .session(session || null)
      .lean(),
    Payment.find({ business: businessId, customer: customerId, status: 'completed', unappliedAmount: { $gt: 0 } })
      .select('reference receivedAt amount allocatedAmount unappliedAmount')
      .session(session || null)
      .lean()
  ]);

  const rows = [
    ...notes.map((note) => ({
      source: 'credit_note',
      id: note._id,
      reference: note.documentNumber,
      sourceDate: note.date,
      total: money(note.total),
      applied: money(note.appliedAmount),
      remaining: money(money(note.total) - money(note.appliedAmount))
    })),
    ...payments.map((payment) => ({
      source: 'payment',
      id: payment._id,
      reference: payment.reference || '',
      sourceDate: payment.receivedAt,
      total: money(payment.amount),
      applied: money(payment.allocatedAmount),
      remaining: money(payment.unappliedAmount)
    }))
  ].filter((row) => row.remaining > 0);

  rows.sort(
    (left, right) =>
      new Date(left.sourceDate) - new Date(right.sourceDate) || String(left.id).localeCompare(String(right.id))
  );
  return rows;
};

export const findSettlementAllocation = (businessId, allocationId, { session } = {}) =>
  SettlementAllocation.findOne({ _id: allocationId, business: businessId }).session(session || null);

// Compare-and-set on `reversedAt`: a replayed reversal returns null rather than double-
// releasing the source. Reversal is a flag, never a delete.
export const markAllocationReversed = (businessId, allocationId, { actorId, reason, session } = {}) =>
  SettlementAllocation.findOneAndUpdate(
    { _id: allocationId, business: businessId, reversedAt: null },
    { $set: { reversedAt: new Date(), reversedBy: actorId || null, reversalReason: reason || '' } },
    { new: true, session }
  );

export const deleteSettlementAllocations = (ids, { session } = {}) =>
  SettlementAllocation.deleteMany({ _id: { $in: ids } }, { session });

// The ledger pair a credit application posted, found by the allocation it was stamped with.
// Excludes 'adjustment' so a reversal is never itself reversed.
export const ledgerEntriesForAllocation = (businessId, allocationId, { session } = {}) =>
  LedgerEntry.find({
    business: businessId,
    'metadata.allocationId': allocationId,
    sourceType: { $in: ['payment', 'credit_note'] }
  })
    .session(session || null)
    .lean();

// Live (issued) credit notes raised against an invoice. An invoice cannot be cancelled
// while any of these stand — the note is a filed GST document referencing it, and the
// credit it holds would otherwise be unbacked.
export const liveCreditNoteCountForInvoice = (businessId, invoiceId, { session } = {}) =>
  Invoice.countDocuments({
    business: businessId,
    documentType: 'credit_note',
    sourceInvoice: invoiceId,
    documentStatus: 'issued'
  }).session(session || null);

// Every settlement still counting against an invoice, whatever funded it.
export const liveAllocationsForInvoice = (businessId, invoiceId, { session } = {}) =>
  SettlementAllocation.find({ business: businessId, invoice: invoiceId, reversedAt: null })
    .sort({ allocatedAt: 1 })
    .session(session || null)
    .lean();

// Live applications of one credit note — the provenance list shown on its detail screen.
export const applicationsForCreditNote = (businessId, creditNoteId, { session } = {}) =>
  SettlementAllocation.find({ business: businessId, creditNote: creditNoteId, reversedAt: null })
    .sort({ allocatedAt: 1 })
    .populate('invoice', 'invoiceNumber documentNumber date')
    .session(session || null)
    .lean();

/**
 * The customer's two balances, from disjoint inputs so both can be non-zero at once:
 *
 *   outstandingDues = max(invoiced - settled, 0)
 *   availableCredit = max((creditIssued - creditConsumed) + unappliedCash, 0)
 *
 * A credit note does NOT reduce `invoiced`. Issuing one creates credit the customer holds;
 * it changes what they owe only when that credit is explicitly applied, which shows up
 * here as a settlement allocation (raising `settled`) and as `appliedAmount` on the note
 * (raising `creditConsumed`). Each side is counted exactly once, in a different formula.
 *
 * The `max(x, 0)` floors are defensive only — the write-time guards keep both differences
 * non-negative. A floor that binds is a bug signal, not normal operation.
 */
export const customerBalanceTotals = async (businessId, customerId, { session } = {}) => {
  const [invoiceTotals, allocationTotals, unappliedTotals, creditNoteTotals] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          business: businessId,
          documentType: 'invoice',
          customer: customerId,
          documentStatus: { $nin: ['cancelled', 'void'] }
        }
      },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]).session(session || null),
    // Exclude allocations tied to cancelled/void invoices: when an invoice is
    // cancelled we keep its payment + allocation for audit, but that money must
    // not settle the customer's other open invoices (it is owed back as a
    // pending refund, tracked on the Payment itself).
    SettlementAllocation.aggregate([
      { $match: { business: businessId, customer: customerId, reversedAt: null } },
      { $lookup: { from: 'salesdocuments', localField: 'invoice', foreignField: '_id', as: 'doc' } },
      // Same reason as above, plus deletedAt: a $lookup bypasses the tombstone hook.
      { $match: { 'doc.documentStatus': { $nin: ['cancelled', 'void'] }, 'doc.deletedAt': null } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).session(session || null),
    Payment.aggregate([
      { $match: { business: businessId, customer: customerId, status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$unappliedAmount' } } }
    ]).session(session || null),
    // Issued credit notes are the customer's credit pool, not a discount on their dues.
    // Issued and consumed come from the same documents, so one aggregate produces both.
    Invoice.aggregate([
      {
        $match: {
          business: businessId,
          documentType: 'credit_note',
          customer: customerId,
          documentStatus: { $nin: ['cancelled', 'void'] }
        }
      },
      { $group: { _id: null, issued: { $sum: '$total' }, consumed: { $sum: { $ifNull: ['$appliedAmount', 0] } } } }
    ]).session(session || null)
  ]);

  const invoiced = invoiceTotals[0]?.total || 0;
  const settled = allocationTotals[0]?.total || 0;
  const unappliedCash = unappliedTotals[0]?.total || 0;
  const creditIssued = creditNoteTotals[0]?.issued || 0;
  const creditConsumed = creditNoteTotals[0]?.consumed || 0;

  return {
    outstandingDues: Math.max(invoiced - settled, 0),
    availableCredit: Math.max(creditIssued - creditConsumed + unappliedCash, 0)
  };
};

export const updateCustomerBalance = async (businessId, customerId, totals, { session, actorId } = {}) => {
  const now = new Date();
  const balance = await CustomerBalance.findOneAndUpdate(
    { business: businessId, customer: customerId },
    { ...totals, lastCalculatedAt: now },
    { new: true, runValidators: true, upsert: true, setDefaultsOnInsert: true, session }
  );

  await Customer.findOneAndUpdate(
    { _id: customerId, business: businessId },
    { availableCredit: totals.availableCredit, outstandingDues: totals.outstandingDues, updatedBy: actorId || null },
    { session }
  );

  return balance;
};

export const listPaymentRecords = (filter) => Payment.find(filter).sort({ receivedAt: -1, createdAt: -1 });

// Payment ids that were allocated to a given invoice (covers multi-invoice
// payments whose stored `invoice` field points at a different invoice).
export const paymentIdsAllocatedToInvoice = async (businessId, invoiceId) => {
  // `source: 'payment'` — credit-note allocations carry no payment id, so they would
  // contribute nulls here.
  const allocations = await SettlementAllocation.find({ business: businessId, invoice: invoiceId, source: 'payment' })
    .select('payment')
    .lean();
  return allocations.map((allocation) => allocation.payment);
};
