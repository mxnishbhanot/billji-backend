import { body, query } from 'express-validator';
import crypto from 'crypto';
import Invoice from '../models/Invoice.js';
import { cancelInvoiceWorkflow, computeInvoiceEligibility, createInvoiceWorkflow, deleteInvoiceWorkflow, duplicateInvoiceWorkflow } from '../modules/invoices/service.js';
import { meterDocument } from '../middlewares/entitlement.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  buildInvoiceShareMessage,
  buildCustomerSnapshot,
  buildPublicInvoicePdfUrl,
  buildWhatsAppLink,
  getInvoiceForBusiness,
  normalizeItems,
  resolveDocumentSupply,
  serializeInvoice
} from '../services/invoiceService.js';
import { DOCUMENT_KINDS } from '../modules/documents/documentTypes.js';
import { DEFAULT_REMINDER_TEMPLATE, listPendingReminders, sendReminders } from '../services/reminderService.js';
import { sendInvoiceEmail } from '../services/emailService.js';
import { generateInvoicePdf } from '../services/invoice/pdfService.js';
import { getOrRenderInvoicePdf } from '../services/invoicePdfCache.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../services/eventBus.js';
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
  // Customer is optional entirely (walk-in / cash sale). But an inline customer, once
  // given, still has to be complete — a half-typed one would print a nameless invoice.
  body('customer.name').if(body('customer').exists()).trim().notEmpty(),
  body('customer.phone').if(body('customer').exists()).trim().notEmpty(),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.productId').optional({ nullable: true }).isMongoId(),
  body('items.*.name').optional().trim().isLength({ max: 120 }),
  body('items.*.quantity').isInt({ min: 1 }),
  body('items.*.price').optional().isFloat({ min: 0 }),
  body('items.*.hsn').optional({ nullable: true }).trim().isLength({ max: 8 }).withMessage('HSN/SAC must be 8 characters or fewer'),
  body('items.*.taxRate').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
  body('placeOfSupplyCode').optional({ nullable: true, checkFalsy: true }).isLength({ min: 2, max: 2 }).withMessage('Place of supply must be a 2-digit state code'),
  body('taxRate').optional().isFloat({ min: 0, max: 100 }),
  body('discountType').optional().isIn(['flat', 'percentage']),
  body('discountValue').optional().isFloat({ min: 0 }),
  body('allowOversell').optional().isBoolean().toBoolean(),
  // Present only on a document a device issued offline. The value is checked against that
  // device's numbering series in modules/sync/deviceRegistry; this is the shape check.
  body('documentNumber').optional({ checkFalsy: true }).isString().trim().isLength({ max: 16 }),
  body('invoiceNumber').optional({ checkFalsy: true }).isString().trim().isLength({ max: 16 }),
  body('date').optional({ checkFalsy: true }).isISO8601(),
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
  query('customerId').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid customer id'),
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
  const { search = '', status, from, to, minAmount, maxAmount, sort, customerId } = req.query;
  const filter = { business: req.business._id, documentType: 'invoice' };

  if (status) {
    filter.status = status;
  }

  if (customerId) {
    filter.customer = customerId;
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
  // The monthly document quota is charged here, not inside the workflow: the create must be
  // refused before a number is allocated, and released if the workflow then fails. Offline
  // pushes come through the same controller with `req.offlineSync` set — those are counted as
  // overage and never refused (the document is already in a customer's hands).
  const invoice = await meterDocument(req, () => createInvoiceWorkflow({ req }), { res, offline: Boolean(req.offlineSync) });

  void logAudit(req, { action: 'invoice.created', resourceType: 'invoice', resourceId: invoice._id, metadata: { invoiceNumber: invoice.invoiceNumber, total: invoice.total } });
  res.status(201).json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const previewInvoice = asyncHandler(async (req, res) => {
  const { snapshot } = await buildCustomerSnapshot(req.business._id, req.body);
  const items = await normalizeItems(req.business._id, req.body.items || [], { allowOversell: true });
  const { placeOfSupply, supplyType } = resolveDocumentSupply(req.business, snapshot, req.body);
  const totals = calculateInvoiceTotals({
    items,
    taxRate: req.body.taxRate,
    discountType: req.body.discountType,
    discountValue: req.body.discountValue,
    supplyType,
    pricesIncludeTax: Boolean(req.business?.taxSettings?.pricesIncludeTax)
  });

  // The builder previews quotations and challans through this endpoint too — the type
  // decides the title, watermark and disclaimer the customer will see on the PDF.
  const documentType = DOCUMENT_KINDS.includes(req.body.documentType) ? req.body.documentType : 'invoice';

  const previewInvoiceData = {
    documentType,
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
    placeOfSupply,
    supplyType,
    taxSummary: totals.taxSummary,
    total: totals.total,
    paidAmount: 0,
    balanceDue: totals.total,
    notes: req.body.notes || ''
  };

  // The preview *is* the PDF the customer will receive, not a look-alike of it, so there
  // is one layout to maintain. Base64 over text/plain keeps the client's response handling
  // unchanged and survives the JSON-free transport the mobile viewer expects.
  const pdf = await generateInvoicePdf(previewInvoiceData, req.business);
  res.type('text/plain').send(pdf.toString('base64'));
});

export const getInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  const eligibility = await computeInvoiceEligibility(req.business._id, invoice);
  res.json({ success: true, invoice: { ...serializeInvoice(invoice, req), eligibility } });
});

export const updateInvoiceStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;

  // paid/pending must go through the payment/ledger workflows — mutating status here
  // left invoices looking settled while Customer.outstandingDues still counted them.
  if (status === 'paid' || status === 'pending') {
    throw new ApiError(422, 'Record or reverse a payment to change payment status', {
      code: 'PAYMENT_STATUS_VIA_PAYMENTS'
    });
  }

  if (status !== 'cancelled') {
    throw new ApiError(422, 'Invalid invoice status');
  }

  const invoice = await cancelInvoiceWorkflow({ req });
  void logAudit(req, { action: 'invoice.status_updated', resourceType: 'invoice', resourceId: invoice._id, metadata: { status } });
  return res.json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const duplicateInvoice = asyncHandler(async (req, res) => {
  const clone = await meterDocument(req, () => duplicateInvoiceWorkflow({ req }), { res });

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
  if (invoice.status === 'cancelled') {
    throw new ApiError(409, 'Cancelled invoices cannot be shared or sent');
  }
  const pdf = await getOrRenderInvoicePdf(invoice, req.business);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(pdf);
});

export const publicInvoicePdf = asyncHandler(async (req, res) => {
  // Any sales document, not only tax invoices: a quotation or challan is shared with the
  // same tokenised link, and the template stamps it for what it is.
  const invoice = await Invoice.findOne({ _id: req.params.id, shareToken: req.params.token }).populate('business');

  if (!invoice) {
    throw new ApiError(404, 'Invoice not found');
  }

  if (invoice.business?.status && invoice.business.status !== 'active') {
    throw new ApiError(404, 'Invoice not found');
  }

  if (invoice.shareRevokedAt || (invoice.shareExpiresAt && invoice.shareExpiresAt < new Date())) {
    throw new ApiError(410, 'Invoice link has expired');
  }

  const pdf = await getOrRenderInvoicePdf(invoice, invoice.business);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoiceNumber || invoice.documentNumber}.pdf"`);
  res.send(pdf);
});

export const whatsappInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  if (invoice.status === 'cancelled') {
    throw new ApiError(409, 'Cancelled invoices cannot be shared or sent');
  }
  const [link, message] = await Promise.all([
    buildWhatsAppLink(invoice, req),
    buildInvoiceShareMessage(invoice, req)
  ]);
  res.json({ success: true, link, message });
});

export const emailInvoice = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  if (invoice.status === 'cancelled') {
    throw new ApiError(409, 'Cancelled invoices cannot be shared or sent');
  }
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

export const reminderRules = [
  body('invoiceIds').isArray({ min: 1 }).withMessage('Select at least one invoice'),
  body('invoiceIds.*').isMongoId().withMessage('Invalid invoice id')
];

export const pendingReminders = asyncHandler(async (req, res) => {
  const result = await listPendingReminders(req.business._id);
  res.json({
    success: true,
    ...result,
    template: req.business.reminderTemplate || DEFAULT_REMINDER_TEMPLATE
  });
});

export const prepareReminders = asyncHandler(async (req, res) => {
  const { reminders, requested, prepared } = await sendReminders({ req, invoiceIds: req.body.invoiceIds });

  void logAudit(req, {
    action: 'invoice.reminders_sent',
    resourceType: 'invoice',
    metadata: { requested, prepared, channel: 'whatsapp' }
  });
  emitBusinessEvent(req.business._id, 'notifications:changed', { reason: 'payment_reminders' });

  res.json({ success: true, reminders, requested, prepared });
});

export const rotateInvoiceShareLink = asyncHandler(async (req, res) => {
  const invoice = await getInvoiceForBusiness(req.business._id, req.params.id);
  if (invoice.status === 'cancelled') {
    throw new ApiError(409, 'Cancelled invoices cannot be shared or sent');
  }
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
