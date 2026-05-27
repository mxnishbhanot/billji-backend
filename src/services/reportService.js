import Invoice from '../models/Invoice.js';

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

export const getReportSummary = async (userId, range = {}) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrow = addDays(todayStart, 1);
  const weekStart = addDays(todayStart, -6);
  const monthStart = startOfMonth(now);
  const rangeDateFilter = buildDateFilter(range);
  const baseFilter = rangeDateFilter ? { user: userId, date: rangeDateFilter } : { user: userId };
  const rangePaidFilter = { ...baseFilter, status: 'paid' };
  const trendFilter = rangeDateFilter ? rangePaidFilter : { user: userId, status: 'paid', date: { $gte: weekStart, $lt: tomorrow } };
  const rangeLabel = rangeDateFilter ? 'Selected range' : 'Last 7 days';

  const paidFilter = { user: userId, status: 'paid' };

  const [today, weekly, monthly, rangeSales, counts, topProducts, trend, recentInvoices] = await Promise.all([
    Invoice.aggregate([
      { $match: { ...paidFilter, date: { $gte: todayStart, $lt: tomorrow } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]),
    Invoice.aggregate([
      { $match: { ...paidFilter, date: { $gte: weekStart, $lt: tomorrow } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]),
    Invoice.aggregate([
      { $match: { ...paidFilter, date: { $gte: monthStart, $lt: tomorrow } } },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]),
    Invoice.aggregate([
      { $match: trendFilter },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]),
    Invoice.aggregate([
      { $match: baseFilter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          value: { $sum: '$total' }
        }
      }
    ]),
    Invoice.aggregate([
      { $match: { ...baseFilter, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          quantity: { $sum: '$items.quantity' },
          sales: { $sum: '$items.total' }
        }
      },
      { $sort: { sales: -1 } },
      { $limit: 5 }
    ]),
    Invoice.aggregate([
      { $match: trendFilter },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          sales: { $sum: '$total' },
          invoices: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Invoice.find(baseFilter).sort({ createdAt: -1 }).limit(5)
  ]);

  const totalInvoices = counts.reduce((sum, item) => sum + item.count, 0);
  const totalValue = counts.reduce((sum, item) => sum + item.value, 0);
  const pending = counts.find((item) => item._id === 'pending')?.count || 0;

  return {
    todaySales: today[0]?.total || 0,
    weeklySales: weekly[0]?.total || 0,
    monthlySales: monthly[0]?.total || 0,
    rangeSales: rangeSales[0]?.total || 0,
    rangeLabel,
    totalInvoices,
    pendingInvoices: pending,
    averageInvoiceValue: totalInvoices ? totalValue / totalInvoices : 0,
    invoiceCounts: counts.reduce((acc, item) => ({ ...acc, [item._id]: item.count }), {}),
    topProducts: topProducts.map((item) => ({ name: item._id, quantity: item.quantity, sales: item.sales })),
    salesTrend: trend.map((item) => ({ date: item._id, sales: item.sales, invoices: item.invoices })),
    recentInvoices
  };
};
