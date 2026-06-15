import { body, query } from 'express-validator';
import crypto from 'crypto';
import Invoice from '../models/Invoice.js';
import { cancelInvoiceWorkflow, createInvoiceWorkflow, deleteInvoiceWorkflow, duplicateInvoiceWorkflow } from '../modules/invoices/service.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  buildInvoiceShareMessage,
  buildCustomerSnapshot,
  buildPublicInvoicePdfUrl,
  buildWhatsAppLink,
  getInvoiceForBusiness,
  normalizeItems,
  serializeInvoice
} from '../services/invoiceService.js';
import { sendInvoiceEmail } from '../services/emailService.js';
import { buildInvoiceHtml } from '../services/invoiceHtml.js';
import { generateInvoicePdf } from '../services/pdfService.js';
import { resolveInvoiceReminderNotifications } from '../services/notificationService.js';
import { emitBusinessEvent } from '../services/socketService.js';
import { logAudit } from '../services/auditService.js';
import { paginateQuery, UNPAGINATED_LIST_CAP, wantsPagination } from '../utils/pagination.js';
import { buildSearchRegex } from '../utils/searchRegex.js';
import { calculateInvoiceTotals } from '../utils/invoiceMath.js';

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
  const filter = { business: req.business._id, documentType: 'invoice' };

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

  const searchRegex = buildSearchRegex(search);
  if (searchRegex) {
    filter.$or = [
      { invoiceNumber: searchRegex },
      { 'customerSnapshot.name': searchRegex },
      { 'customerSnapshot.phone': searchRegex }
    ];
  }

  const sortSpec = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;
  const query = Invoice.find(filter).sort(sortSpec).lean();

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, Invoice.countDocuments(filter), req.query);
    return res.json({ success: true, invoices: items.map((invoice) => serializeInvoice(invoice, req)), pagination });
  }

  const invoices = await query.limit(UNPAGINATED_LIST_CAP);
  res.json({ success: true, invoices: invoices.map((invoice) => serializeInvoice(invoice, req)) });
});

const emitInvoiceChanges = (businessId, reason, { stockChanged = false } = {}) => {
  emitBusinessEvent(businessId, 'invoices:changed', { reason });
  emitBusinessEvent(businessId, 'notifications:changed', { reason });

  if (stockChanged) {
    emitBusinessEvent(businessId, 'products:changed', { reason });
  }
};

export const createInvoice = asyncHandler(async (req, res) => {
  const invoice = await createInvoiceWorkflow({ req });

  void logAudit(req, { action: 'invoice.created', resourceType: 'invoice', resourceId: invoice._id, metadata: { invoiceNumber: invoice.invoiceNumber, total: invoice.total } });
  res.status(201).json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const previewInvoice = asyncHandler(async (req, res) => {
  const { snapshot } = await buildCustomerSnapshot(req.business._id, req.body);
  const items = await normalizeItems(req.business._id, req.body.items || [], { allowOversell: true });
  const totals = calculateInvoiceTotals({
    items,
    taxRate: req.body.taxRate,
    discountType: req.body.discountType,
    discountValue: req.body.discountValue
  });

  const previewInvoiceData = {
    invoiceNumber: `${req.business.invoicePrefix || 'INV'}-PREVIEW`,
    date: new Date().toISOString(),
    dueDate: null,
    status: 'pending',
    paymentStatus: 'unpaid',
    customerSnapshot: snapshot,
    items: totals.items,
    subtotal: totals.subtotal,
    tax: totals.tax,
    discount: totals.discount,
    total: totals.total,
    paidAmount: 0,
    balanceDue: totals.total,
    notes: req.body.notes || ''
  };

  const html = buildInvoiceHtml(previewInvoiceData, req.business, { mode: 'screen' });
  res.type('html').send(html);
});

export const getInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  res.json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const updateInvoiceStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  if (!['pending', 'paid', 'cancelled'].includes(status)) {
    throw new ApiError(422, 'Invalid invoice status');
  }

  if (status === 'cancelled') {
    const invoice = await cancelInvoiceWorkflow({ req });
    void logAudit(req, { action: 'invoice.status_updated', resourceType: 'invoice', resourceId: invoice._id, metadata: { status } });
    return res.json({ success: true, invoice: serializeInvoice(invoice, req) });
  }

  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  invoice.status = status;
  invoice.paidAmount = status === 'paid' ? invoice.total : 0;
  invoice.balanceDue = status === 'paid' ? 0 : invoice.total;
  invoice.updatedBy = req.user._id;
  await invoice.save();

  if (status === 'paid') {
    await resolveInvoiceReminderNotifications(req.business._id, invoice._id);
  }
  emitInvoiceChanges(req.business._id, 'invoice_status_updated');
  void logAudit(req, { action: 'invoice.status_updated', resourceType: 'invoice', resourceId: invoice._id, metadata: { status } });
  res.json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const duplicateInvoice = asyncHandler(async (req, res) => {
  const clone = await duplicateInvoiceWorkflow({ req });

  void logAudit(req, { action: 'invoice.duplicated', resourceType: 'invoice', resourceId: clone._id, metadata: { sourceInvoiceId: req.params.id } });
  res.status(201).json({ success: true, invoice: serializeInvoice(clone, req) });
});

export const deleteInvoice = asyncHandler(async (req, res) => {
  const invoice = await deleteInvoiceWorkflow({ req });

  void logAudit(req, { action: 'invoice.deleted', resourceType: 'invoice', resourceId: invoice._id, metadata: { invoiceNumber: invoice.invoiceNumber } });
  res.json({ success: true, message: 'Invoice deleted' });
});

export const downloadInvoicePdf = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  const pdf = await generateInvoicePdf(invoice, req.business);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(pdf);
});

export const publicInvoicePdf = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findOne({ _id: req.params.id, shareToken: req.params.token, documentType: 'invoice' }).populate('business');

  if (!invoice) {
    throw new ApiError(404, 'Invoice not found');
  }

  if (invoice.business?.status && invoice.business.status !== 'active') {
    throw new ApiError(404, 'Invoice not found');
  }

  if (invoice.shareRevokedAt || (invoice.shareExpiresAt && invoice.shareExpiresAt < new Date())) {
    throw new ApiError(410, 'Invoice link has expired');
  }

  const pdf = await generateInvoicePdf(invoice, invoice.business);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(pdf);
});

export const whatsappInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  res.json({
    success: true,
    link: buildWhatsAppLink(invoice, req),
    message: buildInvoiceShareMessage(invoice, req)
  });
});

export const emailInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  const result = await sendInvoiceEmail({ invoice, business: req.business, to: req.body.email, pdfUrl: buildPublicInvoicePdfUrl(invoice, req) });
  await publishDomainEvent({
    business: req.business._id,
    actor: req.user._id,
    eventType: DOMAIN_EVENTS.documentShared,
    aggregateType: 'sales_document',
    aggregateId: invoice._id,
    payload: {
      documentType: invoice.documentType || 'invoice',
      documentNumber: invoice.documentNumber || invoice.invoiceNumber,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customer,
      customerName: invoice.customerSnapshot?.name,
      recipient: result.recipient,
      channel: 'email'
    },
    dedupeKey: `${DOMAIN_EVENTS.documentShared}:${invoice._id}:email:${result.recipient}`
  });

  res.json({ success: true, message: `Invoice sent to ${result.recipient}` });
});

export const rotateInvoiceShareLink = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  invoice.shareToken = crypto.randomBytes(24).toString('hex');
  invoice.shareExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  invoice.shareRevokedAt = null;
  invoice.updatedBy = req.user._id;
  await invoice.save();

  void logAudit(req, { action: 'invoice.share_rotated', resourceType: 'invoice', resourceId: invoice._id });
  res.json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const revokeInvoiceShareLink = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  invoice.shareRevokedAt = new Date();
  invoice.updatedBy = req.user._id;
  await invoice.save();

  void logAudit(req, { action: 'invoice.share_revoked', resourceType: 'invoice', resourceId: invoice._id });
  res.json({ success: true, invoice: serializeInvoice(invoice, req) });
});
