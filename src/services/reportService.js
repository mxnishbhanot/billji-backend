import Invoice from '../models/Invoice.js';

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);

export const getReportSummary = async (userId) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrow = addDays(todayStart, 1);
  const weekStart = addDays(todayStart, -6);
  const monthStart = startOfMonth(now);

  const paidFilter = { user: userId, status: 'paid' };

  const [today, weekly, monthly, counts, topProducts, trend, recentInvoices] = await Promise.all([
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
      { $match: { user: userId } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          value: { $sum: '$total' }
        }
      }
    ]),
    Invoice.aggregate([
      { $match: { user: userId, status: { $ne: 'cancelled' } } },
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
      { $match: { ...paidFilter, date: { $gte: weekStart, $lt: tomorrow } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          sales: { $sum: '$total' },
          invoices: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Invoice.find({ user: userId }).sort({ createdAt: -1 }).limit(6)
  ]);

  const totalInvoices = counts.reduce((sum, item) => sum + item.count, 0);
  const totalValue = counts.reduce((sum, item) => sum + item.value, 0);
  const pending = counts.find((item) => item._id === 'pending')?.count || 0;

  return {
    todaySales: today[0]?.total || 0,
    weeklySales: weekly[0]?.total || 0,
    monthlySales: monthly[0]?.total || 0,
    totalInvoices,
    pendingInvoices: pending,
    averageInvoiceValue: totalInvoices ? totalValue / totalInvoices : 0,
    invoiceCounts: counts.reduce((acc, item) => ({ ...acc, [item._id]: item.count }), {}),
    topProducts: topProducts.map((item) => ({ name: item._id, quantity: item.quantity, sales: item.sales })),
    salesTrend: trend.map((item) => ({ date: item._id, sales: item.sales, invoices: item.invoices })),
    recentInvoices
  };
};
