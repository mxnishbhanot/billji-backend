import { body, query } from 'express-validator';
import Payment from '../../models/Payment.js';
import PurchaseBill from '../../models/PurchaseBill.js';
import Vendor from '../../models/Vendor.js';
import { PAYMENT_METHODS } from '../../models/Payment.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logAudit } from '../../services/auditService.js';
import { emitBusinessEvent } from '../../services/socketService.js';
import { invalidateReportSummaryCache } from '../../services/reportService.js';
import { paginateQuery, UNPAGINATED_LIST_CAP, wantsPagination } from '../../utils/pagination.js';
import { buildSearchRegex } from '../../utils/searchRegex.js';
import {
  cancelPurchaseWorkflow,
  createPurchaseWorkflow,
  getPurchaseForBusiness,
  getVendorForBusiness,
  recordVendorPaymentWorkflow,
  refreshVendorPayable,
  vendorPayableTotals
} from './service.js';

const afterWrite = (req, reason) => {
  invalidateReportSummaryCache(req.business._id);
  emitBusinessEvent(req.business._id, 'purchases:changed', { reason });
  // Receiving stock changes inventory, so product lists are stale too.
  emitBusinessEvent(req.business._id, 'products:changed', { reason });
};

/* ---------------------------------- vendors --------------------------------- */

export const vendorRules = [
  body('name').trim().notEmpty().withMessage('Vendor name is required').isLength({ max: 120 }),
  body('phone').optional({ nullable: true }).trim().isLength({ max: 24 }),
  body('email').optional({ nullable: true, checkFalsy: true }).isEmail(),
  body('gstNumber').optional({ nullable: true }).trim().isLength({ max: 32 }),
  body('panNumber').optional({ nullable: true }).trim().isLength({ max: 10 }),
  body('address').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 })
];

export const listVendors = asyncHandler(async (req, res) => {
  const filter = { business: req.business._id };
  const searchRegex = buildSearchRegex(req.query.search || '');
  if (searchRegex) filter.$or = [{ name: searchRegex }, { phone: searchRegex }, { gstNumber: searchRegex }];

  const vendors = await Vendor.find(filter).sort({ name: 1 }).limit(UNPAGINATED_LIST_CAP).lean();
  res.json({ success: true, vendors });
});

export const createVendor = asyncHandler(async (req, res) => {
  const vendor = await Vendor.create({
    business: req.business._id,
    createdBy: req.user._id,
    updatedBy: req.user._id,
    name: req.body.name,
    phone: req.body.phone || '',
    countryCode: req.body.countryCode || '+91',
    email: req.body.email || '',
    address: req.body.address || '',
    gstNumber: req.body.gstNumber || '',
    panNumber: req.body.panNumber || '',
    notes: req.body.notes || ''
  });

  void logAudit(req, { action: 'vendor.created', resourceType: 'vendor', resourceId: vendor._id, metadata: { name: vendor.name } });
  res.status(201).json({ success: true, vendor });
});

export const updateVendor = asyncHandler(async (req, res) => {
  const vendor = await getVendorForBusiness(req.business._id, req.params.id);

  for (const field of ['name', 'phone', 'countryCode', 'email', 'address', 'gstNumber', 'panNumber', 'notes']) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) vendor[field] = req.body[field] || '';
  }
  vendor.updatedBy = req.user._id;
  await vendor.save();

  void logAudit(req, { action: 'vendor.updated', resourceType: 'vendor', resourceId: vendor._id });
  res.json({ success: true, vendor });
});

export const getVendorOutstanding = asyncHandler(async (req, res) => {
  const vendor = await getVendorForBusiness(req.business._id, req.params.id);
  const totals = await vendorPayableTotals(req.business._id, vendor._id);
  const bills = await PurchaseBill.find({ business: req.business._id, vendor: vendor._id, status: 'received', balanceDue: { $gt: 0 } })
    .sort({ date: 1 })
    .select('billNumber vendorBillNumber date total paidAmount balanceDue')
    .lean();

  res.json({ success: true, vendor, ...totals, bills });
});

/* --------------------------------- purchases -------------------------------- */

export const purchaseRules = [
  body('vendorId').isMongoId().withMessage('Choose a vendor'),
  body('items').isArray({ min: 1 }).withMessage('Add at least one item'),
  body('items.*.productId').optional({ nullable: true }).isMongoId(),
  body('items.*.name').optional().trim().isLength({ max: 120 }),
  body('items.*.quantity').isInt({ min: 1 }),
  body('items.*.price').isFloat({ min: 0 }),
  body('items.*.taxRate').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
  body('items.*.hsn').optional({ nullable: true }).trim().isLength({ max: 8 }),
  body('taxRate').optional().isFloat({ min: 0, max: 100 }),
  body('discountType').optional().isIn(['flat', 'percentage']),
  body('discountValue').optional().isFloat({ min: 0 }),
  body('vendorBillNumber').optional({ nullable: true }).trim().isLength({ max: 64 }),
  body('date').optional({ checkFalsy: true }).isISO8601(),
  body('dueDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 })
];

export const purchaseQueryRules = [
  query('search').optional({ checkFalsy: true }).trim().isLength({ max: 80 }),
  query('status').optional({ checkFalsy: true }).isIn(['received', 'cancelled']),
  query('paymentStatus').optional({ checkFalsy: true }).isIn(['unpaid', 'partial', 'paid']),
  query('vendorId').optional({ checkFalsy: true }).isMongoId(),
  query('from').optional({ checkFalsy: true }).isISO8601(),
  query('to').optional({ checkFalsy: true }).isISO8601(),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 })
];

export const listPurchases = asyncHandler(async (req, res) => {
  const { search = '', status, paymentStatus, vendorId, from, to } = req.query;
  const filter = { business: req.business._id };

  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (vendorId) filter.vendor = vendorId;
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }

  const searchRegex = buildSearchRegex(search);
  if (searchRegex) {
    filter.$or = [{ billNumber: searchRegex }, { vendorBillNumber: searchRegex }, { 'vendorSnapshot.name': searchRegex }];
  }

  const query = PurchaseBill.find(filter).sort({ date: -1, createdAt: -1 }).lean();

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, PurchaseBill.countDocuments(filter), req.query);
    return res.json({ success: true, purchases: items, pagination });
  }

  const purchases = await query.limit(UNPAGINATED_LIST_CAP);
  res.json({ success: true, purchases });
});

export const getPurchase = asyncHandler(async (req, res) => {
  const purchase = await getPurchaseForBusiness(req.business._id, req.params.id);
  const payments = await Payment.find({ business: req.business._id, purchaseBill: purchase._id }).sort({ receivedAt: -1 }).lean();
  res.json({ success: true, purchase, payments });
});

export const createPurchase = asyncHandler(async (req, res) => {
  const purchase = await createPurchaseWorkflow({ req });

  void logAudit(req, {
    action: 'purchase.created',
    resourceType: 'purchase_bill',
    resourceId: purchase._id,
    metadata: { billNumber: purchase.billNumber, total: purchase.total }
  });
  afterWrite(req, 'created');

  res.status(201).json({ success: true, purchase });
});

export const cancelPurchase = asyncHandler(async (req, res) => {
  const purchase = await cancelPurchaseWorkflow({ req });

  void logAudit(req, { action: 'purchase.cancelled', resourceType: 'purchase_bill', resourceId: purchase._id });
  afterWrite(req, 'cancelled');

  res.json({ success: true, purchase });
});

export const vendorPaymentRules = [
  body('amount').isFloat({ min: 0.01 }).withMessage('Enter an amount greater than zero'),
  body('method').optional({ checkFalsy: true }).isIn(PAYMENT_METHODS),
  body('billId').optional({ nullable: true }).isMongoId(),
  body('reference').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 }),
  body('paidAt').optional({ checkFalsy: true }).isISO8601()
];

export const recordVendorPayment = asyncHandler(async (req, res) => {
  const { payment, bill, totals } = await recordVendorPaymentWorkflow({ req });

  void logAudit(req, {
    action: 'vendor_payment.recorded',
    resourceType: 'vendor',
    resourceId: req.params.id,
    metadata: { amount: payment.amount, billNumber: bill?.billNumber }
  });
  afterWrite(req, 'vendor_payment');

  res.status(201).json({ success: true, payment, bill, ...totals });
});

export const recalculateVendorPayable = asyncHandler(async (req, res) => {
  const vendor = await getVendorForBusiness(req.business._id, req.params.id);
  const totals = await refreshVendorPayable(req.business._id, vendor._id, { actorId: req.user._id });
  res.json({ success: true, ...totals });
});
