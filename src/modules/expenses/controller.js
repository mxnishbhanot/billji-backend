import { body, query } from 'express-validator';
import Expense, { EXPENSE_CATEGORIES } from '../../models/Expense.js';
import { PAYMENT_METHODS } from '../../models/Payment.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logAudit } from '../../services/auditService.js';
import { emitBusinessEvent } from '../../services/socketService.js';
import { invalidateReportSummaryCache } from '../../services/reportService.js';
import { paginateQuery, UNPAGINATED_LIST_CAP, wantsPagination } from '../../utils/pagination.js';
import { buildSearchRegex } from '../../utils/searchRegex.js';
import { createExpenseWorkflow, expenseTotals, getExpenseForBusiness, serializeExpense, updateExpenseWorkflow, voidExpenseWorkflow } from './service.js';

const parseDateParam = (value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
};
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

export const expenseRules = [
  body('amount').isFloat({ min: 0 }).withMessage('Amount must be zero or greater'),
  body('taxAmount').optional({ nullable: true }).isFloat({ min: 0 }),
  body('category').optional({ checkFalsy: true }).isIn(EXPENSE_CATEGORIES).withMessage('Unknown expense category'),
  body('paymentMethod').optional({ checkFalsy: true }).isIn(PAYMENT_METHODS).withMessage('Unknown payment method'),
  body('date').optional({ checkFalsy: true }).isISO8601(),
  body('vendorName').optional({ nullable: true }).trim().isLength({ max: 120 }),
  body('reference').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 })
];

export const expenseQueryRules = [
  query('search').optional({ checkFalsy: true }).trim().isLength({ max: 80 }),
  query('category').optional({ checkFalsy: true }).isIn(EXPENSE_CATEGORIES),
  query('from').optional({ checkFalsy: true }).isISO8601(),
  query('to').optional({ checkFalsy: true }).isISO8601(),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 })
];

const listFilter = (req) => {
  const { search = '', category = '', from = '', to = '', includeVoided } = req.query;
  // Voided rows are hidden by default: they exist for the audit trail, not the list.
  const filter = { business: req.business._id, ...(includeVoided === 'true' ? {} : { voidedAt: null }) };

  if (category) filter.category = category;

  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = startOfDay(parseDateParam(from));
    if (to) filter.date.$lte = endOfDay(parseDateParam(to));
  }

  const searchRegex = buildSearchRegex(search);
  if (searchRegex) {
    filter.$or = [{ vendorName: searchRegex }, { reference: searchRegex }, { notes: searchRegex }];
  }

  return filter;
};

export const listExpenses = asyncHandler(async (req, res) => {
  const filter = listFilter(req);
  const query = Expense.find(filter).sort({ date: -1, createdAt: -1 }).lean();

  const summary = await expenseTotals(req.business._id, {
    from: filter.date?.$gte,
    to: filter.date?.$lte
  });

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, Expense.countDocuments(filter), req.query);
    return res.json({ success: true, expenses: items.map(serializeExpense), summary, pagination });
  }

  const expenses = await query.limit(UNPAGINATED_LIST_CAP);
  res.json({ success: true, expenses: expenses.map(serializeExpense), summary });
});

export const getExpense = asyncHandler(async (req, res) => {
  const expense = await getExpenseForBusiness(req.business._id, req.params.id);
  res.json({ success: true, expense: serializeExpense(expense) });
});

// Reports read expenses, so every write invalidates the cached summary the same way an
// invoice or payment does.
const afterWrite = (req, reason) => {
  invalidateReportSummaryCache(req.business._id);
  emitBusinessEvent(req.business._id, 'expenses:changed', { reason });
};

export const createExpense = asyncHandler(async (req, res) => {
  const expense = await createExpenseWorkflow({ req });

  void logAudit(req, { action: 'expense.created', resourceType: 'expense', resourceId: expense._id, metadata: { total: expense.total, category: expense.category } });
  afterWrite(req, 'created');

  res.status(201).json({ success: true, expense: serializeExpense(expense) });
});

export const updateExpense = asyncHandler(async (req, res) => {
  const expense = await updateExpenseWorkflow({ req });

  void logAudit(req, { action: 'expense.updated', resourceType: 'expense', resourceId: expense._id, metadata: { total: expense.total } });
  afterWrite(req, 'updated');

  res.json({ success: true, expense: serializeExpense(expense) });
});

export const deleteExpense = asyncHandler(async (req, res) => {
  const expense = await voidExpenseWorkflow({ req });

  void logAudit(req, { action: 'expense.deleted', resourceType: 'expense', resourceId: expense._id });
  afterWrite(req, 'deleted');

  res.json({ success: true, expense: serializeExpense(expense) });
});

export const expenseCategories = asyncHandler(async (_req, res) => {
  res.json({ success: true, categories: EXPENSE_CATEGORIES });
});
