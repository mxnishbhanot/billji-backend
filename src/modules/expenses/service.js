import Expense from '../../models/Expense.js';
import LedgerEntry from '../../models/LedgerEntry.js';
import { ApiError } from '../../utils/ApiError.js';
import { withTransaction } from '../../utils/transaction.js';
import { createLedgerEntries } from '../payments/repository.js';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Cash and bank are real asset accounts; everything else (UPI, card, cheque, wallet)
// settles into the bank in practice, so it credits bank rather than inventing an account
// per instrument.
const fundingAccountFor = (paymentMethod) => (paymentMethod === 'cash' ? 'cash' : 'bank');

export const serializeExpense = (row) => {
  const data = row.toObject ? row.toObject() : row;
  return { ...data, _id: String(data._id), isVoided: Boolean(data.voidedAt) };
};

export const getExpenseForBusiness = async (businessId, expenseId, { session } = {}) => {
  const expense = await Expense.findOne({ _id: expenseId, business: businessId }).session(session || null);
  if (!expense) throw new ApiError(404, 'Expense not found');
  return expense;
};

/**
 * Double entry for one expense: the expense account is debited, and whatever paid for it
 * is credited. Same shape as the sales postings, so the ledger screen reads consistently.
 */
const ledgerEntriesFor = (expense, actorId) => {
  const total = money(expense.total);
  const shared = {
    business: expense.business,
    sourceType: 'expense',
    sourceId: expense._id,
    amount: total,
    currency: expense.currency || 'INR',
    entryDate: expense.date || new Date(),
    createdBy: actorId
  };
  const label = `${expense.category} expense${expense.vendorName ? ` — ${expense.vendorName}` : ''}`;

  return [
    { ...shared, account: 'expenses', direction: 'debit', description: label },
    { ...shared, account: fundingAccountFor(expense.paymentMethod), direction: 'credit', description: `${label} (paid by ${expense.paymentMethod})` }
  ];
};

const buildPayload = (body, user, business) => {
  const amount = money(body.amount);
  const taxAmount = money(body.taxAmount);

  return {
    business: business._id,
    createdBy: user._id,
    updatedBy: user._id,
    date: body.date ? new Date(body.date) : new Date(),
    category: body.category || 'other',
    amount,
    taxAmount,
    // Total is always derived — a client-supplied total could disagree with its parts.
    total: money(amount + taxAmount),
    paymentMethod: body.paymentMethod || 'cash',
    vendorName: body.vendorName || '',
    reference: body.reference || '',
    notes: body.notes || ''
  };
};

export const createExpenseWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const payload = buildPayload(req.body, req.user, req.business);
    const [expense] = await Expense.create([payload], { session });

    await createLedgerEntries(ledgerEntriesFor(expense, req.user._id), { session });

    return expense;
  });

/**
 * Editing re-posts the ledger rather than patching the old rows: the amount, the date or
 * the funding account may all have moved, and reversing-then-reposting keeps the trail
 * honest about what changed.
 */
export const updateExpenseWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const expense = await getExpenseForBusiness(req.business._id, req.params.id, { session });
    if (expense.voidedAt) throw new ApiError(409, 'A deleted expense cannot be edited', { code: 'EXPENSE_VOIDED' });

    const payload = buildPayload(req.body, req.user, req.business);
    Object.assign(expense, payload, { createdBy: expense.createdBy, updatedBy: req.user._id });
    await expense.save({ session });

    await LedgerEntry.deleteMany({ business: req.business._id, sourceType: 'expense', sourceId: expense._id }, { session });
    await createLedgerEntries(ledgerEntriesFor(expense, req.user._id), { session });

    return expense;
  });

/**
 * Delete is a void: the row survives so the reversal has something to reference, and so a
 * deleted expense cannot silently disappear from an already-filed month. Compensating
 * entries mirror the originals rather than removing them.
 */
export const voidExpenseWorkflow = ({ req }) =>
  withTransaction(async (session) => {
    const expense = await getExpenseForBusiness(req.business._id, req.params.id, { session });
    if (expense.voidedAt) return expense;

    const originals = await LedgerEntry.find({
      business: req.business._id,
      sourceType: 'expense',
      sourceId: expense._id
    })
      .session(session)
      .lean();

    if (originals.length) {
      const reversedAt = new Date();
      await createLedgerEntries(
        originals.map((entry) => ({
          business: entry.business,
          sourceType: 'adjustment',
          sourceId: expense._id,
          account: entry.account,
          direction: entry.direction === 'debit' ? 'credit' : 'debit',
          amount: entry.amount,
          currency: entry.currency,
          entryDate: reversedAt,
          description: `Reversal (expense deleted): ${entry.description}`,
          createdBy: req.user._id,
          metadata: { reversalOf: entry._id }
        })),
        { session }
      );
    }

    expense.voidedAt = new Date();
    expense.voidedBy = req.user._id;
    expense.updatedBy = req.user._id;
    await expense.save({ session });

    return expense;
  });

/** Totals by category for a period. Voided rows never count. */
export const expenseTotals = async (businessId, { from, to } = {}) => {
  const match = { business: businessId, voidedAt: null };
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = from;
    if (to) match.date.$lte = to;
  }

  const [rows] = await Expense.aggregate([
    { $match: match },
    {
      $facet: {
        total: [{ $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 } } }],
        byCategory: [
          { $group: { _id: '$category', total: { $sum: '$total' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } }
        ]
      }
    }
  ]);

  return {
    total: money(rows?.total?.[0]?.total || 0),
    count: rows?.total?.[0]?.count || 0,
    byCategory: (rows?.byCategory || []).map((row) => ({ category: row._id, total: money(row.total), count: row.count }))
  };
};
