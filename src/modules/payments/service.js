import Invoice from '../../models/Invoice.js';
import { legacyStatusFor } from '../../models/SalesDocument.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../../services/eventBus.js';
import { ApiError } from '../../utils/ApiError.js';
import { withTransaction } from '../../utils/transaction.js';
import { reverseLedgerEntries } from '../invoices/service.js';
import {
  allocationTotalsForInvoice,
  claimCreditFromNote,
  claimCreditFromPayment,
  createLedgerEntries,
  createSettlementAllocation,
  createPaymentRecord,
  creditSourcesForCustomer,
  customerBalanceTotals,
  deleteSettlementAllocations,
  findSettlementAllocation,
  ledgerEntriesForAllocation,
  listPaymentRecords,
  liveAllocationsForInvoice,
  markAllocationReversed,
  markInvoiceRefundProcessed,
  paymentIdsAllocatedToInvoice,
  releaseCreditToNote,
  releaseCreditToPayment,
  updateCustomerBalance
} from './repository.js';

const money = (value) => Math.round(Number(value || 0) * 100) / 100;

const accountForMethod = (method) => (['bank_transfer', 'card', 'cheque', 'upi', 'wallet'].includes(method) ? 'bank' : 'cash');

const serializePayment = (payment) => (payment.toObject ? payment.toObject() : payment);
const serializeAllocation = (allocation) => (allocation.toObject ? allocation.toObject() : allocation);

// Recompute an invoice's paid/balance/status after applying `allocatedAmount` of money
// on top of what money had already settled it (`paidBefore`).
//
// `paidAmount` is cash only; credit that settled this invoice sits in `creditApplied` and
// is subtracted separately, so an invoice never claims to have been paid with money that
// never arrived.
const applyInvoicePayment = (invoice, paidBefore, allocatedAmount, actorId) => {
  const invoiceTotal = money(invoice.total);
  const creditApplied = money(invoice.creditApplied);
  const paidAmount = money(Math.min(paidBefore + allocatedAmount, Math.max(invoiceTotal - creditApplied, 0)));
  const balanceDue = money(Math.max(invoiceTotal - paidAmount - creditApplied, 0));
  invoice.paidAmount = paidAmount;
  invoice.balanceDue = balanceDue;
  invoice.paymentStatus = balanceDue <= 0 ? 'paid' : paidAmount + creditApplied > 0 ? 'partial' : 'unpaid';
  invoice.status = legacyStatusFor(invoice);
  invoice.updatedBy = actorId;
  return { paidAmount, balanceDue };
};

const ledgerBase = (req, payment, invoice) => ({
  business: req.business._id,
  customer: payment.customer || null,
  salesDocument: invoice._id,
  invoice: invoice._id,
  payment: payment._id,
  sourceType: 'payment',
  sourceId: payment._id,
  currency: payment.currency,
  createdBy: req.user._id
});

const cashDebitEntry = (req, payment, invoice, amount, entryDate) => ({
  ...ledgerBase(req, payment, invoice),
  account: accountForMethod(payment.method),
  direction: 'debit',
  amount,
  entryDate,
  description: `Payment received for ${invoice.invoiceNumber}`
});

const receivableCreditEntry = (req, payment, invoice, amount, entryDate) => ({
  ...ledgerBase(req, payment, invoice),
  account: 'accounts_receivable',
  direction: 'credit',
  amount,
  entryDate,
  description: `Receivable settled for ${invoice.invoiceNumber}`
});

const customerCreditEntry = (req, payment, invoice, amount, entryDate) => ({
  ...ledgerBase(req, payment, invoice),
  account: 'customer_credits',
  direction: 'credit',
  amount,
  entryDate,
  description: `Customer credit from overpayment for ${invoice.invoiceNumber}`
});

export const paymentBalanceForInvoice = async (businessId, invoiceId, { session } = {}) => {
  const invoice = await Invoice.findOne({ _id: invoiceId, business: businessId, documentType: 'invoice' }).session(session || null);
  if (!invoice) throw new ApiError(404, 'Invoice not found');

  const totals = await allocationTotalsForInvoice(businessId, invoice._id, { session });
  const total = money(invoice.total);
  const paidAmount = money(totals.paidAmount);
  const creditApplied = money(totals.creditApplied);
  const settled = money(paidAmount + creditApplied);
  return {
    invoice,
    paidAmount,
    creditApplied,
    balanceDue: Math.max(money(total - settled), 0),
    // Everything that has settled this invoice, whatever funded it — the figure a new
    // payment's headroom is measured against.
    totalAllocated: settled
  };
};

export const recordInvoicePaymentWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const amount = money(req.body.amount);
    if (amount <= 0) throw new ApiError(422, 'Payment amount must be greater than zero');

    const {
      invoice,
      totalAllocated,
      paidAmount: paidBefore
    } = await paymentBalanceForInvoice(req.business._id, req.params.invoiceId, { session });
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
      allocation = await createSettlementAllocation({
        business: req.business._id,
        source: 'payment',
        payment: payment._id,
        salesDocument: invoice._id,
        invoice: invoice._id,
        customer: customerId,
        amount: allocatedAmount,
        allocatedAt: receivedAt,
        createdBy: req.user._id
      }, { session });
    }

    applyInvoicePayment(invoice, paidBefore, allocatedAmount, req.user._id);
    await invoice.save({ session });

    const ledgerEntries = [cashDebitEntry(req, payment, invoice, amount, receivedAt)];
    if (allocatedAmount > 0) {
      ledgerEntries.push(receivableCreditEntry(req, payment, invoice, allocatedAmount, receivedAt));
    }
    if (unappliedAmount > 0) {
      ledgerEntries.push(customerCreditEntry(req, payment, invoice, unappliedAmount, receivedAt));
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
          sourceOrder: invoice.sourceOrder || null,
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

// Outstanding (unpaid/partial) invoices for a customer, oldest-first, with the
// canonical balanceDue derived from allocations (not the denormalized field).
export const getCustomerOutstanding = async (businessId, customerId) => {
  const invoices = await Invoice.find({
    business: businessId,
    customer: customerId,
    documentType: 'invoice',
    documentStatus: { $nin: ['cancelled', 'void'] },
    paymentStatus: { $in: ['unpaid', 'partial'] }
  })
    .sort({ date: 1, createdAt: 1 })
    .lean();

  const rows = [];
  let totalOutstanding = 0;
  for (const invoice of invoices) {
    // Both funding sources settle the invoice, so both come off what is still owed.
    const { total: settled } = await allocationTotalsForInvoice(businessId, invoice._id);
    const balanceDue = money(Math.max(money(invoice.total) - money(settled), 0));
    if (balanceDue <= 0) continue;
    totalOutstanding = money(totalOutstanding + balanceDue);
    rows.push({
      id: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      date: invoice.date,
      total: money(invoice.total),
      balanceDue
    });
  }

  return { invoices: rows, totalOutstanding };
};

// Record ONE payment from a customer and allocate it across multiple invoices in
// priority order (`invoiceIds`: dues oldest->newest, then the new invoice last).
// Greedy: each invoice is filled to its balance; any leftover becomes customer credit.
export const recordCustomerPaymentWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const amount = money(req.body.amount);
    if (amount <= 0) throw new ApiError(422, 'Payment amount must be greater than zero');

    const invoiceIds = Array.isArray(req.body.invoiceIds) ? req.body.invoiceIds : [];
    if (!invoiceIds.length) throw new ApiError(422, 'At least one invoice is required');

    const seenInvoiceIds = new Set();
    for (const invoiceId of invoiceIds) {
      const key = String(invoiceId);
      if (seenInvoiceIds.has(key)) {
        throw new ApiError(422, 'Duplicate invoice ids are not allowed in one payment', {
          code: 'DUPLICATE_INVOICE_IDS'
        });
      }
      seenInvoiceIds.add(key);
    }

    const customerId = req.params.customerId;

    // Load + validate every target invoice (server is source of truth for balances).
    const targets = [];
    for (const invoiceId of invoiceIds) {
      const { invoice, totalAllocated, paidAmount: paidBefore } = await paymentBalanceForInvoice(req.business._id, invoiceId, { session });
      if (['cancelled', 'void'].includes(invoice.documentStatus)) {
        throw new ApiError(409, `Cannot record payment for cancelled invoice ${invoice.invoiceNumber}`);
      }
      if (String(invoice.customer || '') !== String(customerId)) {
        throw new ApiError(422, `Invoice ${invoice.invoiceNumber} does not belong to this customer`);
      }
      const balance = money(Math.max(money(invoice.total) - money(totalAllocated), 0));
      targets.push({ invoice, totalAllocated, paidBefore, balance, allocatedAmount: 0 });
    }

    // Greedy fill in the order received.
    let remaining = amount;
    for (const target of targets) {
      const alloc = money(Math.min(remaining, target.balance));
      target.allocatedAmount = alloc;
      remaining = money(remaining - alloc);
    }
    const unappliedAmount = money(remaining);
    const allocatedTotal = money(amount - unappliedAmount);

    // Use the invoice's ObjectId customer ref (the route param is a string and
    // would not match in the customer-balance aggregates).
    const customerRef = targets[0].invoice.customer || null;
    // allowCredit defaults to true (e.g. settling dues + a new invoice). When the
    // caller is purely collecting dues, it passes false so an overpayment is rejected
    // instead of silently parked as customer credit.
    const allowCredit = req.body.allowCredit !== false;
    if (unappliedAmount > 0 && !allowCredit) {
      throw new ApiError(422, "Amount exceeds the selected invoices' outstanding balance");
    }
    if (unappliedAmount > 0 && !customerRef) {
      throw new ApiError(422, 'Overpayment requires a saved customer');
    }

    const lastInvoice = targets[targets.length - 1].invoice;
    const receivedAt = req.body.receivedAt ? new Date(req.body.receivedAt) : new Date();

    const payment = await createPaymentRecord({
      business: req.business._id,
      customer: customerRef,
      salesDocument: lastInvoice._id,
      invoice: lastInvoice._id,
      createdBy: req.user._id,
      updatedBy: req.user._id,
      type: req.body.type || 'receipt',
      method: req.body.method || 'cash',
      status: 'completed',
      amount,
      allocatedAmount: allocatedTotal,
      unappliedAmount,
      currency: req.body.currency || 'INR',
      reference: req.body.reference || '',
      notes: req.body.notes || '',
      receivedAt,
      provider: req.body.provider || {},
      statusHistory: [{ status: 'completed', at: receivedAt, note: req.body.notes || 'Payment recorded' }],
      metadata: req.body.metadata || {}
    }, { session });

    const allocations = [];
    const ledgerEntries = [cashDebitEntry(req, payment, lastInvoice, amount, receivedAt)];

    for (const target of targets) {
      if (target.allocatedAmount <= 0) continue;
      const allocation = await createSettlementAllocation({
        business: req.business._id,
        source: 'payment',
        payment: payment._id,
        salesDocument: target.invoice._id,
        invoice: target.invoice._id,
        customer: customerRef,
        amount: target.allocatedAmount,
        allocatedAt: receivedAt,
        createdBy: req.user._id
      }, { session });
      allocations.push(allocation);

      applyInvoicePayment(target.invoice, target.paidBefore, target.allocatedAmount, req.user._id);
      await target.invoice.save({ session });
      ledgerEntries.push(receivableCreditEntry(req, payment, target.invoice, target.allocatedAmount, receivedAt));
    }

    if (unappliedAmount > 0) {
      ledgerEntries.push(customerCreditEntry(req, payment, lastInvoice, unappliedAmount, receivedAt));
    }

    await createLedgerEntries(ledgerEntries, { session });

    let customerBalance = null;
    if (customerRef) {
      const totals = await customerBalanceTotals(req.business._id, customerRef, { session });
      customerBalance = await updateCustomerBalance(req.business._id, customerRef, totals, { session, actorId: req.user._id });
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
          invoiceId: lastInvoice._id,
          invoiceNumber: lastInvoice.invoiceNumber,
          allocations: allocations.map((a) => ({ invoiceId: a.invoice, amount: a.amount })),
          customerId: customerRef,
          customerName: lastInvoice.customerSnapshot?.name,
          amount,
          allocatedAmount: allocatedTotal,
          unappliedAmount,
          currency: payment.currency,
          method: payment.method,
          receivedAt
        },
        dedupeKey: `${DOMAIN_EVENTS.paymentRecorded}:${payment._id}`
      },
      { session }
    );

    return { payment, allocations, invoices: targets.map((target) => target.invoice), customerBalance };
  });

// Rewrite an invoice's settlement fields from the authoritative allocation totals. The
// credit paths change several allocation rows at once, so they recompute from the sums
// rather than folding one delta at a time like `applyInvoicePayment` does.
const settleInvoiceFromTotals = (invoice, totals, actorId) => {
  const paidAmount = money(totals.paidAmount);
  const creditApplied = money(totals.creditApplied);
  const balanceDue = money(Math.max(money(invoice.total) - paidAmount - creditApplied, 0));
  invoice.paidAmount = paidAmount;
  invoice.creditApplied = creditApplied;
  invoice.balanceDue = balanceDue;
  invoice.paymentStatus = balanceDue <= 0 ? 'paid' : paidAmount + creditApplied > 0 ? 'partial' : 'unpaid';
  invoice.status = legacyStatusFor(invoice);
  invoice.updatedBy = actorId;
  return { paidAmount, creditApplied, balanceDue };
};

// A credit application discharges the liability BillJi owes the customer by settling a
// receivable — structurally the same pair as a cash allocation, only the debit account
// differs. Stamped with `allocationId` so the reversal can find exactly this pair.
const creditApplicationEntries = (req, invoice, plan, allocation, entryDate) => {
  const label = plan.source === 'credit_note' ? `credit note ${plan.reference}` : 'an overpayment';
  const base = {
    business: req.business._id,
    customer: invoice.customer || null,
    salesDocument: invoice._id,
    invoice: invoice._id,
    payment: plan.source === 'payment' ? plan.id : null,
    sourceType: plan.source,
    sourceId: plan.id,
    currency: invoice.currency || 'INR',
    entryDate,
    createdBy: req.user._id,
    metadata: { allocationId: allocation._id }
  };

  return [
    {
      ...base,
      account: 'customer_credits',
      direction: 'debit',
      amount: plan.amount,
      description: `Credit applied to ${invoice.invoiceNumber} from ${label}`
    },
    {
      ...base,
      account: 'accounts_receivable',
      direction: 'credit',
      amount: plan.amount,
      description: `Receivable settled for ${invoice.invoiceNumber}`
    }
  ];
};

// The customer's credit pool, itemised, plus its total (§7). Derived on every read — there
// is no stored wallet to drift.
export const getCustomerCredits = async (businessId, customerId) => {
  const sources = await creditSourcesForCustomer(businessId, customerId);
  const availableCredit = sources.reduce((sum, source) => money(sum + source.remaining), 0);
  return {
    credits: sources.map((source) => ({
      source: source.source,
      id: String(source.id),
      reference: source.reference,
      date: source.sourceDate,
      total: source.total,
      applied: source.applied,
      remaining: source.remaining
    })),
    availableCredit
  };
};

// Apply `amount` of the customer's credit to one invoice, consuming sources oldest-first
// and writing one allocation row per source consumed, so provenance survives.
export const applyCreditWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const amount = money(req.body.amount);
    if (amount <= 0) throw new ApiError(422, 'Credit amount must be greater than zero');

    const { invoice, balanceDue } = await paymentBalanceForInvoice(req.business._id, req.params.invoiceId, { session });
    if (['cancelled', 'void'].includes(invoice.documentStatus)) {
      throw new ApiError(409, 'Cannot apply credit to a cancelled invoice');
    }

    const customerId = invoice.customer || null;
    if (!customerId) throw new ApiError(422, 'Credit can only be applied to an invoice with a saved customer');

    if (amount > balanceDue) {
      throw new ApiError(409, `Amount exceeds the invoice balance of ${balanceDue}`, {
        code: 'CREDIT_EXCEEDS_BALANCE',
        balanceDue
      });
    }

    const sources = await creditSourcesForCustomer(req.business._id, customerId, { session });
    const availableCredit = sources.reduce((sum, source) => money(sum + source.remaining), 0);
    if (amount > availableCredit) {
      throw new ApiError(409, `Amount exceeds the available credit of ${availableCredit}`, {
        code: 'INSUFFICIENT_CREDIT',
        availableCredit
      });
    }

    // Greedy fill down the FIFO list — the same loop the multi-invoice allocator uses.
    const plan = [];
    let remaining = amount;
    for (const source of sources) {
      if (remaining <= 0) break;
      const take = money(Math.min(remaining, source.remaining));
      if (take <= 0) continue;
      plan.push({ ...source, amount: take });
      remaining = money(remaining - take);
    }

    const claimed = [];
    const allocations = [];
    const ledgerEntries = [];
    const appliedAt = new Date();

    try {
      for (const item of plan) {
        // Claim before writing anything: the compare-and-set is what makes two concurrent
        // applies of the same credit resolve to one winner and one 409.
        const won =
          item.source === 'credit_note'
            ? await claimCreditFromNote(req.business._id, { _id: item.id, total: item.total }, item.amount, { session })
            : await claimCreditFromPayment(req.business._id, item.id, item.amount, { session });
        if (!won) {
          throw new ApiError(409, 'That credit was just used elsewhere. Reload and try again.', {
            code: 'CREDIT_SOURCE_CONSUMED'
          });
        }
        claimed.push(item);

        const allocation = await createSettlementAllocation(
          {
            business: req.business._id,
            source: item.source,
            payment: item.source === 'payment' ? item.id : null,
            creditNote: item.source === 'credit_note' ? item.id : null,
            salesDocument: invoice._id,
            invoice: invoice._id,
            customer: customerId,
            amount: item.amount,
            allocatedAt: appliedAt,
            createdBy: req.user._id
          },
          { session }
        );
        allocations.push(allocation);
        ledgerEntries.push(...creditApplicationEntries(req, invoice, item, allocation, appliedAt));
      }

      await createLedgerEntries(ledgerEntries, { session });
    } catch (error) {
      // Without a session there is no rollback, so undo by hand: give every claim back and
      // drop the rows already written. Compensation failures must not mask the real error.
      if (!session) {
        if (allocations.length) {
          await deleteSettlementAllocations(allocations.map((allocation) => allocation._id)).catch(() => null);
        }
        for (const item of claimed) {
          await (item.source === 'credit_note'
            ? releaseCreditToNote(req.business._id, item.id, item.amount)
            : releaseCreditToPayment(req.business._id, item.id, item.amount)
          ).catch(() => null);
        }
      }
      throw error;
    }

    const totals = await allocationTotalsForInvoice(req.business._id, invoice._id, { session });
    settleInvoiceFromTotals(invoice, totals, req.user._id);
    await invoice.save({ session });

    const balanceTotals = await customerBalanceTotals(req.business._id, customerId, { session });
    const customerBalance = await updateCustomerBalance(req.business._id, customerId, balanceTotals, {
      session,
      actorId: req.user._id
    });

    return { invoice, allocations, customerBalance, appliedAmount: amount };
  });

// Undo one application: flag it reversed, hand the amount back to the source it came from,
// and post the compensating ledger pair. `entries` is the pair the application posted —
// its presence is what identifies an allocation as an application at all.
const reverseOneApplication = async (req, invoice, allocation, entries, { session, reason = '' } = {}) => {
  const reversed = await markAllocationReversed(req.business._id, allocation._id, {
    actorId: req.user._id,
    reason,
    session
  });
  // Lost the race to a concurrent reversal — that one released the source, so stop here.
  if (!reversed) return null;

  const released =
    allocation.source === 'credit_note'
      ? await releaseCreditToNote(req.business._id, allocation.creditNote, allocation.amount, { session })
      : await releaseCreditToPayment(req.business._id, allocation.payment, allocation.amount, { session });
  if (!released) throw new ApiError(409, 'The credit source could not be restored', { code: 'CREDIT_RELEASE_FAILED' });

  await reverseLedgerEntries(req, invoice, entries, { session, note: 'credit application reversed' });
  return reversed;
};

/**
 * Cancelling an invoice returns every credit that was applied to it (§10.2). Mandatory,
 * not a nicety: the allocation stops counting the moment the invoice is cancelled, so
 * without this the source's `appliedAmount` / `allocatedAmount` would stay consumed
 * against an invoice that no longer exists and the credit would simply vanish.
 *
 * Only *applications* are reversed — allocations a receipt wrote are left alone and follow
 * the cash rule (kept, payment flagged refund-pending), because that money physically
 * arrived and can only be refunded, never un-received. The stamped ledger pair is what
 * tells the two apart, exactly as in the single-allocation reversal endpoint.
 */
export const reverseCreditApplicationsForInvoice = async (req, invoice, { session } = {}) => {
  const allocations = await liveAllocationsForInvoice(req.business._id, invoice._id, { session });

  let reversedCount = 0;
  for (const allocation of allocations) {
    const entries = await ledgerEntriesForAllocation(req.business._id, allocation._id, { session });
    if (!entries.length) continue;
    const reversed = await reverseOneApplication(req, invoice, allocation, entries, {
      session,
      reason: `Invoice ${invoice.invoiceNumber || invoice.documentNumber} cancelled`
    });
    if (reversed) reversedCount += 1;
  }

  return reversedCount;
};

// Undo one credit application: flag the allocation reversed, hand the amount back to the
// source it came from, and post the compensating ledger pair. Never deletes anything.
export const reverseCreditApplicationWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const allocation = await findSettlementAllocation(req.business._id, req.params.allocationId, { session });
    if (!allocation) throw new ApiError(404, 'Allocation not found');

    const invoice = await Invoice.findOne({ _id: allocation.invoice, business: req.business._id }).session(session || null);
    if (!invoice) throw new ApiError(404, 'Invoice not found');

    // Already reversed: idempotent no-op, matching cancellation's early return.
    if (allocation.reversedAt) return { invoice, allocation, customerBalance: null, reversed: false };

    // A cancelled invoice's credit applications are unwound by cancellation itself, so
    // there is nothing left to reverse here.
    if (['cancelled', 'void'].includes(invoice.documentStatus)) {
      return { invoice, allocation, customerBalance: null, reversed: false };
    }

    // The ledger pair is what distinguishes a credit application from the allocation a
    // receipt writes: only applications are stamped with their allocation id. Reversing a
    // receipt's allocation is a refund, which is a different operation.
    const entries = await ledgerEntriesForAllocation(req.business._id, allocation._id, { session });
    if (!entries.length) {
      throw new ApiError(409, 'Only a credit application can be reversed', { code: 'NOT_A_CREDIT_APPLICATION' });
    }

    const reversed = await reverseOneApplication(req, invoice, allocation, entries, {
      session,
      reason: req.body.reason || ''
    });
    if (!reversed) return { invoice, allocation, customerBalance: null, reversed: false };

    const totals = await allocationTotalsForInvoice(req.business._id, invoice._id, { session });
    settleInvoiceFromTotals(invoice, totals, req.user._id);
    await invoice.save({ session });

    let customerBalance = null;
    if (invoice.customer) {
      const balanceTotals = await customerBalanceTotals(req.business._id, invoice.customer, { session });
      customerBalance = await updateCustomerBalance(req.business._id, invoice.customer, balanceTotals, {
        session,
        actorId: req.user._id
      });
    }

    return { invoice, allocation: reversed, customerBalance, reversed: true };
  });

// "Refunded manually": flip a cancelled invoice's refund-pending receipts to
// 'processed' and stamp who/when. Flag-only (no money moved) — cancel already
// unwound the ledger + customer balance. Returns the invoice's updated payments.
export const markInvoiceRefundProcessedWorkflow = async ({ req }) => {
  await withTransaction(async (session) => {
    const invoice = await Invoice.findOne({
      _id: req.params.invoiceId,
      business: req.business._id,
      documentType: 'invoice'
    }).session(session);
    if (!invoice) throw new ApiError(404, 'Invoice not found');

    if (invoice.documentStatus !== 'cancelled') {
      throw new ApiError(409, 'Only a cancelled invoice can have its refund marked processed');
    }

    const modified = await markInvoiceRefundProcessed(req.business._id, invoice._id, req.user._id, { session });
    if (modified === 0) {
      throw new ApiError(409, 'No pending refund to mark for this invoice');
    }

    // Stamp the invoice so the list card can drop its "Refund pending" flag.
    invoice.refundResolvedAt = new Date();
    invoice.updatedBy = req.user._id;
    await invoice.save({ session });
  });

  // Read after commit — listPayments runs without the txn session, so it must
  // see the committed 'processed' values, not the in-flight write.
  return listPayments({ businessId: req.business._id, invoiceId: req.params.invoiceId });
};

export const listPayments = async ({ businessId, invoiceId, customerId }) => {
  const filter = { business: businessId };

  if (invoiceId) {
    // Include payments allocated to this invoice even when the payment's own
    // `invoice` field points at a different (e.g. last) invoice.
    const allocatedPaymentIds = await paymentIdsAllocatedToInvoice(businessId, invoiceId);
    filter.$or = [{ invoice: invoiceId }, { _id: { $in: allocatedPaymentIds } }];
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

export const serializeCreditResult = ({ invoice, allocations, allocation, customerBalance, appliedAmount, reversed }) => ({
  invoice,
  ...(allocations ? { allocations: allocations.map(serializeAllocation) } : {}),
  ...(allocation ? { allocation: serializeAllocation(allocation) } : {}),
  ...(appliedAmount === undefined ? {} : { appliedAmount }),
  ...(reversed === undefined ? {} : { reversed }),
  customerBalance: customerBalance ? serializePayment(customerBalance) : null
});

export const serializeCustomerPaymentResult = ({ payment, allocations, invoices, customerBalance }) => ({
  payment: serializePayment(payment),
  allocations: (allocations || []).map(serializeAllocation),
  invoices,
  customerBalance: customerBalance ? serializePayment(customerBalance) : null
});
