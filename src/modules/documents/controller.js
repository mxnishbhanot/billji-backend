import { body, param, query } from 'express-validator';
import Invoice from '../../models/Invoice.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { logAudit } from '../../services/auditService.js';
import { serializeInvoice } from '../../services/invoiceService.js';
import { emitBusinessEvent } from '../../services/socketService.js';
import { buildSearchRegex } from '../../utils/searchRegex.js';
import { paginateQuery, UNPAGINATED_LIST_CAP, wantsPagination } from '../../utils/pagination.js';
import { DOCUMENT_KINDS, rulesFor } from './documentTypes.js';
import { cancelDocumentWorkflow, convertDocumentWorkflow, createDocumentWorkflow, getDocumentForBusiness } from './service.js';

// documentType arrives in the path so each type keeps its own permissioned route rather
// than being smuggled through a body field.
const documentTypeFrom = (req) => {
  const documentType = req.params.documentType;
  if (!rulesFor(documentType)) throw new ApiError(404, 'Unknown document type');
  return documentType;
};

export const documentTypeRules = [param('documentType').isIn(DOCUMENT_KINDS).withMessage('Unknown document type')];

export const documentRules = [
  ...documentTypeRules,
  body('customerId').optional({ nullable: true }).isMongoId(),
  body('customer.name').if(body('customerId').not().exists()).trim().notEmpty(),
  body('customer.phone').if(body('customerId').not().exists()).trim().notEmpty(),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.productId').optional({ nullable: true }).isMongoId(),
  body('items.*.name').optional().trim().isLength({ max: 120 }),
  body('items.*.quantity').isInt({ min: 1 }),
  body('items.*.price').optional().isFloat({ min: 0 }),
  body('items.*.hsn').optional({ nullable: true }).trim().isLength({ max: 8 }),
  body('items.*.taxRate').optional({ nullable: true }).isFloat({ min: 0, max: 100 }),
  body('taxRate').optional().isFloat({ min: 0, max: 100 }),
  body('discountType').optional().isIn(['flat', 'percentage']),
  body('discountValue').optional().isFloat({ min: 0 }),
  body('placeOfSupplyCode').optional({ nullable: true, checkFalsy: true }).isLength({ min: 2, max: 2 }),
  body('validUntil').optional({ nullable: true, checkFalsy: true }).isISO8601(),
  body('sourceInvoiceId').optional({ nullable: true }).isMongoId(),
  body('reason').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('allowOversell').optional().isBoolean().toBoolean(),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 })
];

export const documentQueryRules = [
  ...documentTypeRules,
  query('search').optional({ checkFalsy: true }).trim().isLength({ max: 80 }),
  query('status').optional({ checkFalsy: true }).isIn(['draft', 'issued', 'cancelled', 'void']),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 })
];

export const listDocuments = asyncHandler(async (req, res) => {
  const documentType = documentTypeFrom(req);
  const filter = { business: req.business._id, documentType };

  if (req.query.status) filter.documentStatus = req.query.status;

  const searchRegex = buildSearchRegex(req.query.search || '');
  if (searchRegex) {
    filter.$or = [{ documentNumber: searchRegex }, { 'customerSnapshot.name': searchRegex }, { 'customerSnapshot.phone': searchRegex }];
  }

  const query = Invoice.find(filter).sort({ date: -1, createdAt: -1 }).lean();

  if (wantsPagination(req.query)) {
    const { items, pagination } = await paginateQuery(query, Invoice.countDocuments(filter), req.query);
    return res.json({ success: true, documents: items.map((document) => serializeInvoice(document, req)), pagination });
  }

  const documents = await query.limit(UNPAGINATED_LIST_CAP);
  res.json({ success: true, documents: documents.map((document) => serializeInvoice(document, req)) });
});

export const getDocument = asyncHandler(async (req, res) => {
  const documentType = documentTypeFrom(req);
  const document = await getDocumentForBusiness(req.business._id, req.params.id, documentType);
  res.json({ success: true, document: serializeInvoice(document, req) });
});

export const createDocument = asyncHandler(async (req, res) => {
  const documentType = documentTypeFrom(req);
  const document = await createDocumentWorkflow({ req, documentType });

  void logAudit(req, {
    action: `${documentType}.created`,
    resourceType: 'sales_document',
    resourceId: document._id,
    metadata: { documentNumber: document.documentNumber, total: document.total }
  });
  emitBusinessEvent(req.business._id, 'invoices:changed', { reason: `${documentType}_created` });

  res.status(201).json({ success: true, document: serializeInvoice(document, req) });
});

export const convertDocument = asyncHandler(async (req, res) => {
  const documentType = documentTypeFrom(req);
  const invoice = await convertDocumentWorkflow({ req, documentType });

  void logAudit(req, {
    action: `${documentType}.converted`,
    resourceType: 'invoice',
    resourceId: invoice._id,
    metadata: { sourceDocumentId: req.params.id, invoiceNumber: invoice.invoiceNumber }
  });
  emitBusinessEvent(req.business._id, 'invoices:changed', { reason: `${documentType}_converted` });

  res.status(201).json({ success: true, invoice: serializeInvoice(invoice, req) });
});

export const cancelDocument = asyncHandler(async (req, res) => {
  const documentType = documentTypeFrom(req);
  const document = await cancelDocumentWorkflow({ req, documentType });

  void logAudit(req, {
    action: `${documentType}.cancelled`,
    resourceType: 'sales_document',
    resourceId: document._id
  });
  emitBusinessEvent(req.business._id, 'invoices:changed', { reason: `${documentType}_cancelled` });

  res.json({ success: true, document: serializeInvoice(document, req) });
});
