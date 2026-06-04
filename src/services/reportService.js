import Invoice from '../models/Invoice.js';
import Payment from '../models/Payment.js';

const SUMMARY_CACHE_TTL_MS = 30 * 1000;
const summaryCache = new Map();

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const invalidateReportSummaryCache = (businessId) => {
  if (businessId) {
    summaryCache.delete(String(businessId));
  } else {
    summaryCache.clear();
  }
};

const parseDateParam = (value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
};
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

const buildDateFilter = ({ from, to } = {}) => {
  if (!from && !to) return null;
  const filter = {};
  if (from) filter.$gte = startOfDay(parseDateParam(from));
  if (to) filter.$lte = endOfDay(parseDateParam(to));
  return filter;
};

const sumTotal = (rows) => money(rows[0]?.total || 0);

export const getReportSummary = async (businessId, range = {}) => {
  const rangeKey = range.from || range.to ? null : String(businessId);
  if (rangeKey) {
    const cached = summaryCache.get(rangeKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }

  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrow = addDays(todayStart, 1);
  const weekStart = addDays(todayStart, -6);
  const monthStart = startOfMonth(now);
  const rangeDateFilter = buildDateFilter(range);
  const rangeLabel = rangeDateFilter ? 'Selected range' : 'Last 7 days';

  const activeDocumentFilter = { documentStatus: { $nin: ['cancelled', 'void'] } };
  // All active (non-cancelled) invoices, scoped to the range when one is set.
  const baseFilter = rangeDateFilter ? { business: businessId, documentType: 'invoice', date: rangeDateFilter } : { business: businessId, documentType: 'invoice' };
  const activeBase = { ...baseFilter, ...activeDocumentFilter };

  // Legacy collected trend (Dashboard back-compat): collected = paid full total + partial collected amount.
  const collectedAmountExpr = { $cond: [{ $eq: ['$paymentStatus', 'partial'] }, { $ifNull: ['$paidAmount', 0] }, '$total'] };
  const legacyTrendFilter = rangeDateFilter ? { ...activeBase, paymentStatus: { $in: ['paid', 'partial'] } } : { ...activeBase, paymentStatus: { $in: ['paid', 'partial'] }, date: { $gte: weekStart, $lt: tomorrow } };

  // ----- Q1: How much did I SELL? (invoiced/gross, every payment status) -----
  const invoicedWindow = (start, end) => ({ business: businessId, documentType: 'invoice', ...activeDocumentFilter, date: { $gte: start, $lt: end } });
  const invoicedTrendFilter = rangeDateFilter ? activeBase : invoicedWindow(weekStart, tomorrow);

  // ----- Q2: How much did I COLLECT? (real payments by receivedAt) -----
  const paymentRangeFilter = rangeDateFilter ? { $gte: rangeDateFilter.$gte ?? new Date(0), ...(rangeDateFilter.$lte ? { $lte: rangeDateFilter.$lte } : {}) } : { $gte: weekStart, $lt: tomorrow };
  const collectedNetExpr = { $sum: { $cond: [{ $eq: ['$type', 'refund'] }, { $multiply: ['$amount', -1] }, '$amount'] } };
  const collectedMatch = (receivedAt) => ({ business: businessId, status: 'completed', receivedAt });
  const collectedWindow = (start, end) => collectedMatch({ $gte: start, $lt: end });

  // ----- Q3: Who OWES me? (snapshot of open balances, NOT range-bound) -----
  const outstandingExpr = { $subtract: ['$total', { $ifNull: ['$paidAmount', 0] }] };
  const duesMatch = { business: businessId, documentType: 'invoice', ...activeDocumentFilter, paymentStatus: { $in: ['unpaid', 'partial'] } };

  const [
    today, weekly, monthly, rangeCollected,
    salesToday, salesWeek, salesMonth, salesRange,
    counts, topProducts, topCustomers, invoicedTrend, legacyTrend, recentInvoices,
    collectedToday, collectedWeek, collectedMonth, collectedRange, paymentMethods,
    duesByStatus, topDebtors
  ] = await Promise.all([
    // Legacy collected fields (kept for Dashboard back-compat): paid full total, partial collected amount.
    Invoice.aggregate([
      { $match: { ...activeBase, paymentStatus: { $in: ['paid', 'partial'] }, date: { $gte: todayStart, $lt: tomorrow } } },
      { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'partial'] }, { $ifNull: ['$paidAmount', 0] }, '$total'] } } } }
    ]),
    Invoice.aggregate([
      { $match: { ...activeBase, paymentStatus: { $in: ['paid', 'partial'] }, date: { $gte: weekStart, $lt: tomorrow } } },
      { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'partial'] }, { $ifNull: ['$paidAmount', 0] }, '$total'] } } } }
    ]),
    Invoice.aggregate([
      { $match: { ...activeBase, paymentStatus: { $in: ['paid', 'partial'] }, date: { $gte: monthStart, $lt: tomorrow } } },
      { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'partial'] }, { $ifNull: ['$paidAmount', 0] }, '$total'] } } } }
    ]),
    Invoice.aggregate([
      { $match: rangeDateFilter ? { ...activeBase, paymentStatus: { $in: ['paid', 'partial'] } } : { ...activeBase, paymentStatus: { $in: ['paid', 'partial'] }, date: { $gte: weekStart, $lt: tomorrow } } },
      { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'partial'] }, { $ifNull: ['$paidAmount', 0] }, '$total'] } } } }
    ]),

    // Q1 invoiced/gross sales by window.
    Invoice.aggregate([{ $match: invoicedWindow(todayStart, tomorrow) }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Invoice.aggregate([{ $match: invoicedWindow(weekStart, tomorrow) }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Invoice.aggregate([{ $match: invoicedWindow(monthStart, tomorrow) }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Invoice.aggregate([{ $match: rangeDateFilter ? activeBase : invoicedWindow(weekStart, tomorrow) }, { $group: { _id: null, total: { $sum: '$total' }, invoices: { $sum: 1 } } }]),

    // Status counts across the range (any status, incl. cancelled — for the status mix grid).
    Invoice.aggregate([
      { $match: baseFilter },
      { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$total' } } }
    ]),
    // Q4 top products by sales in range.
    Invoice.aggregate([
      { $match: activeBase },
      { $unwind: '$items' },
      { $group: { _id: '$items.name', quantity: { $sum: '$items.quantity' }, sales: { $sum: '$items.total' } } },
      { $sort: { sales: -1 } },
      { $limit: 5 }
    ]),
    // Q4 top customers by invoiced sales in range.
    Invoice.aggregate([
      { $match: activeBase },
      { $group: { _id: '$customer', name: { $first: '$customerSnapshot.name' }, sales: { $sum: '$total' }, invoices: { $sum: 1 } } },
      { $sort: { sales: -1 } },
      { $limit: 5 }
    ]),
    // Q1 sales trend (gross invoiced per day).
    Invoice.aggregate([
      { $match: invoicedTrendFilter },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, sales: { $sum: '$total' }, invoices: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]),
    // Legacy collected trend for Dashboard.
    Invoice.aggregate([
      { $match: legacyTrendFilter },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, sales: { $sum: collectedAmountExpr }, invoices: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]),
    Invoice.find(baseFilter).sort({ createdAt: -1 }).limit(5).lean(),

    // Q2 collected (real payments, net of refunds) by window.
    Payment.aggregate([{ $match: collectedWindow(todayStart, tomorrow) }, { $group: { _id: null, total: collectedNetExpr } }]),
    Payment.aggregate([{ $match: collectedWindow(weekStart, tomorrow) }, { $group: { _id: null, total: collectedNetExpr } }]),
    Payment.aggregate([{ $match: collectedWindow(monthStart, tomorrow) }, { $group: { _id: null, total: collectedNetExpr } }]),
    Payment.aggregate([{ $match: collectedMatch(paymentRangeFilter) }, { $group: { _id: null, total: collectedNetExpr } }]),
    // Q2 payment-method breakdown (receipts only) over the active range window.
    Payment.aggregate([
      { $match: { ...collectedMatch(paymentRangeFilter), type: 'receipt' } },
      { $group: { _id: '$method', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { amount: -1 } }
    ]),

    // Q3 outstanding dues snapshot (all-time, NOT range-bound).
    Invoice.aggregate([
      { $match: duesMatch },
      { $group: { _id: '$paymentStatus', count: { $sum: 1 }, amount: { $sum: outstandingExpr } } }
    ]),
    // Q3 top debtors by open balance.
    Invoice.aggregate([
      { $match: duesMatch },
      { $group: { _id: '$customer', name: { $first: '$customerSnapshot.name' }, balance: { $sum: outstandingExpr }, invoices: { $sum: 1 } } },
      { $match: { balance: { $gt: 0 } } },
      { $sort: { balance: -1 } },
      { $limit: 5 }
    ])
  ]);

  const totalInvoices = counts.reduce((sum, item) => sum + item.count, 0);
  const totalValue = counts.reduce((sum, item) => sum + item.value, 0);
  const pending = counts.find((item) => item._id === 'pending')?.count || 0;

  const unpaidRow = duesByStatus.find((item) => item._id === 'unpaid');
  const partialRow = duesByStatus.find((item) => item._id === 'partial');
  const unpaidAmount = money(unpaidRow?.amount || 0);
  const partialAmount = money(partialRow?.amount || 0);

  const collectedInRange = sumTotal(collectedRange);
  const invoicedInRange = sumTotal(salesRange);

  const result = {
    // --- legacy/back-compat fields (Dashboard) ---
    todaySales: sumTotal(today),
    weeklySales: sumTotal(weekly),
    monthlySales: sumTotal(monthly),
    rangeSales: sumTotal(rangeCollected),
    rangeLabel,
    totalInvoices,
    pendingInvoices: pending,
    averageInvoiceValue: totalInvoices ? money(totalValue / totalInvoices) : 0,
    invoiceCounts: counts.reduce((acc, item) => ({ ...acc, [item._id]: item.count }), {}),
    topProducts: topProducts.map((item) => ({ name: item._id, quantity: item.quantity, sales: money(item.sales) })),
    salesTrend: legacyTrend.map((item) => ({ date: item._id, sales: money(item.sales), invoices: item.invoices })),
    recentInvoices,

    // --- Q1: How much did I sell? (invoiced/gross) ---
    sales: {
      today: sumTotal(salesToday),
      week: sumTotal(salesWeek),
      month: sumTotal(salesMonth),
      range: invoicedInRange,
      rangeLabel,
      invoiceCount: salesRange[0]?.invoices || 0,
      trend: invoicedTrend.map((item) => ({ date: item._id, sales: money(item.sales), invoices: item.invoices }))
    },

    // --- Q2: How much did I collect? (real payments) ---
    collected: {
      today: sumTotal(collectedToday),
      week: sumTotal(collectedWeek),
      month: sumTotal(collectedMonth),
      range: collectedInRange,
      rangeLabel,
      // collected vs invoiced for the same window; uncollected can be negative if back-payments land in range.
      invoicedInRange,
      uncollectedInRange: money(Math.max(invoicedInRange - collectedInRange, 0)),
      methodBreakdown: paymentMethods.map((item) => ({ method: item._id || 'other', amount: money(item.amount), count: item.count }))
    },

    // --- Q3: Who owes me money? (open-balance snapshot, all-time) ---
    dues: {
      totalOutstanding: money(unpaidAmount + partialAmount),
      unpaidCount: unpaidRow?.count || 0,
      unpaidAmount,
      partialCount: partialRow?.count || 0,
      partialAmount,
      topDebtors: topDebtors.map((item) => ({
        customerId: item._id ? String(item._id) : null,
        name: item.name || 'Walk-in customer',
        balance: money(item.balance),
        invoices: item.invoices
      }))
    },

    // --- Q4: What is performing well? ---
    performance: {
      topProducts: topProducts.map((item) => ({ name: item._id, quantity: item.quantity, sales: money(item.sales) })),
      topCustomers: topCustomers.map((item) => ({
        customerId: item._id ? String(item._id) : null,
        name: item.name || 'Walk-in customer',
        sales: money(item.sales),
        invoices: item.invoices
      })),
      averageInvoiceValue: totalInvoices ? money(totalValue / totalInvoices) : 0
    }
  };

  if (rangeKey) {
    summaryCache.set(rangeKey, { value: result, expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS });
  }

  return result;
};
