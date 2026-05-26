import { body, query } from 'express-validator';
import Invoice from '../models/Invoice.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  buildInvoicePayload,
  buildInvoiceShareMessage,
  buildPublicInvoicePdfUrl,
  buildWhatsAppLink,
  getInvoiceForUser,
  serializeInvoice,
  setInvoicePdfUrl,
  stockAdjustmentsForInvoice
} from '../services/invoiceService.js';
import { sendInvoiceEmail } from '../services/emailService.js';
import { generateInvoicePdf } from '../services/pdfService.js';
import { emitUserEvent } from '../services/socketService.js';
import { paginateQuery, wantsPagination } from '../utils/pagination.js';

const parseDateParam = (value) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  return new Date(value);
};
const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

export const invoiceRules = [
  body('customerId').optional({ nullable: true }).isMongoId(),
  body('customer.name').if(body('customerId').not().exists()).trim().notEmpty(),
  body('customer.phone').if(body('customerId').not().exists()).trim().notEmpty(),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.productId').optional({ nullable: true }).isMongoId(),
  body('items.*.name').optional().trim().isLength({ max: 120 }),
  body('items.*.quantity').isInt({ min: 1 }),
  body('items.*.price').optional().isFloat({ min: 0 }),
  body('taxRate').optional().isFloat({ min: 0, max: 100 }),
  body('discountType').optional().isIn(['flat', 'percentage']),
  body('discountValue').optional().isFloat({ min: 0 }),
  body('allowOversell').optional().isBoolean().toBoolean(),
  body('status').optional().isIn(['pending', 'paid', 'cancelled']),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 })
];

const SORT_OPTIONS = {
  newest: { date: -1, createdAt: -1 },
  oldest: { date: 1, createdAt: 1 },
  'amount-high': { total: -1, date: -1 },
  'amount-low': { total: 1, date: -1 }
};

export const invoiceQueryRules = [
  query('search').optional({ checkFalsy: true }).trim().isLength({ max: 80 }),
  query('status').optional({ checkFalsy: true }).isIn(['pending', 'paid', 'cancelled']),
  query('from').optional({ checkFalsy: true }).isISO8601(),
  query('to').optional({ checkFalsy: true }).isISO8601(),
  query('minAmount').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('minAmount must be a positive number'),
  query('maxAmount').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('maxAmount must be a positive number'),
  query('sort').optional({ checkFalsy: true }).isIn(Object.keys(SORT_OPTIONS)).withMessage('Invalid sort option'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Page must be 1 or greater'),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
];

export const listInvoices = asyncHandler(async (req, res) => {
  const { search = '', status, from, to, minAmount, maxAmount, sort } = req.query;
  const filter = { user: req.user._id };

  if (status) {
    filter.status = status;
  }

  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = startOfDay(parseDateParam(from));
    if (to) filter.date.$lte = endOfDay(parseDateParam(to));
  }

  if (minAmount || maxAmount) {
    filter.total = {};
    if (minAmount) filter.total.$gte = Number(minAmount);
    if (maxAmount) filter.total.$lte = Number(maxAmount);
  }

  if (search) {
    filter.$or = [
      { invoiceNumber: { $regex: search, $options: 'i' } },
      { 'customerSnapshot.name': { $regex: search, $options: 'i' } },
      { 'customerSnapshot.phone': { $regex: search, $options: 'i' } }
    ];
  }

  const sortSpec = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;
  const query = Invoice.find(filter).sort(sortSpec);

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, Invoice.countDocuments(filter), req.query);
    return res.json({ success: true, invoices: items.map((invoice) => serializeInvoice(invoice, req)), pagination });
  }

  const invoices = await query;
  res.json({ success: true, invoices: invoices.map((invoice) => serializeInvoice(invoice, req)) });
});

const emitInvoiceChanges = (userId, reason, { stockChanged = false } = {}) => {
  emitUserEvent(userId, 'invoices:changed', { reason });
  emitUserEvent(userId, 'notifications:changed', { reason });

  if (stockChanged) {
    emitUserEvent(userId, 'products:changed', { reason });
  }
};

export const createInvoice = asyncHandler(async (req, res) => {
  const payload = await buildInvoicePayload(req.user, req.body);
  const invoice = await Invoice.create(payload);
  await setInvoicePdfUrl(invoice, req);
  await stockAdjustmentsForInvoice(invoice, -1);

  emitInvoiceChanges(req.user._id, 'invoice_created', { stockChanged: true });
  res.status(201).json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const getInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForUser(req.user._id, req.params.id);
  res.json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const updateInvoiceStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  if (!['pending', 'paid', 'cancelled'].includes(status)) {
    throw new ApiError(422, 'Invalid invoice status');
  }

  const invoice = await getInvoiceForUser(req.user._id, req.params.id);
  invoice.status = status;
  await invoice.save();

  emitInvoiceChanges(req.user._id, 'invoice_status_updated');
  res.json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const duplicateInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForUser(req.user._id, req.params.id);
  const payload = await buildInvoicePayload(req.user, {
    customerId: invoice.customer,
    customer: invoice.customerSnapshot,
    items: invoice.items.map((item) => ({
      productId: item.product,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      sku: item.sku
    })),
    taxRate: invoice.tax.rate,
    discountType: invoice.discount.type,
    discountValue: invoice.discount.value,
    status: 'pending',
    notes: invoice.notes
  });
  const clone = await Invoice.create(payload);
  await setInvoicePdfUrl(clone, req);
  await stockAdjustmentsForInvoice(clone, -1);

  emitInvoiceChanges(req.user._id, 'invoice_duplicated', { stockChanged: true });
  res.status(201).json({ success: true, invoice: serializeInvoice(clone, req) });
});

export const deleteInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForUser(req.user._id, req.params.id);
  await stockAdjustmentsForInvoice(invoice, 1);
  await invoice.deleteOne();

  emitInvoiceChanges(req.user._id, 'invoice_deleted', { stockChanged: true });
  res.json({ success: true, message: 'Invoice deleted' });
});

export const downloadInvoicePdf = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForUser(req.user._id, req.params.id);
  const pdf = await generateInvoicePdf(invoice, req.user);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(pdf);
});

export const publicInvoicePdf = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, shareToken: req.params.token }).populate('user');

  if (!invoice) {
    throw new ApiError(404, 'Invoice not found');
  }

  const pdf = await generateInvoicePdf(invoice, invoice.user);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(pdf);
});

export const whatsappInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForUser(req.user._id, req.params.id);
  res.json({
    success: true,
    link: buildWhatsAppLink(invoice, req),
    message: buildInvoiceShareMessage(invoice, req)
  });
});

export const emailInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForUser(req.user._id, req.params.id);
  const result = await sendInvoiceEmail({ invoice, user: req.user, to: req.body.email, pdfUrl: buildPublicInvoicePdfUrl(invoice, req) });

  res.json({ success: true, message: `Invoice sent to ${result.recipient}` });
});
