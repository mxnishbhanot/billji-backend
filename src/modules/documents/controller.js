import { body, param, query } from 'express-validator';
import Invoice from '../../models/Invoice.js';
import { meterDocument } from '../../middlewares/entitlement.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { logAudit } from '../../services/auditService.js';
import { serializeInvoice } from '../../services/invoiceService.js';
import { emitBusinessEvent } from '../../services/socketService.js';
import { buildSearchRegex } from '../../utils/searchRegex.js';
import { paginateQuery, UNPAGINATED_LIST_CAP, wantsPagination } from '../../utils/pagination.js';
import { applicationsForCreditNote } from '../payments/repository.js';
import { DOCUMENT_KINDS, rulesFor } from './documentTypes.js';
import {
  cancelDocumentWorkflow,
  convertDocumentWorkflow,
  createDocumentWorkflow,
  findInvoiceForDocument,
  getDocumentForBusiness,
  stockEffectForDocument
} from './service.js';

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
  const rules = rulesFor(documentType);
  const document = await getDocumentForBusiness(req.business._id, req.params.id, documentType);

  // A convertible document (quotation, challan) records its link on the invoice it produced,
  // so the source side can only answer "which invoice came from me?" by looking it up. Same
  // shape the order detail already returns, and only the fields the UI needs to deep-link.
  // A document that moves stock reports what it actually moved, so the client states a fact
  // instead of inferring one from the document type.
  const [linkedInvoice, stockEffect, applications] = await Promise.all([
    rules.convertsTo ? findInvoiceForDocument(req.business._id, document._id) : null,
    rules.stockDirection === 0 ? null : stockEffectForDocument(req.business._id, document._id),
    // A credit note's detail has to answer "where did my credit go?", which only the
    // allocation rows know. `remaining` is derived here and never stored.
    documentType === 'credit_note' ? applicationsForCreditNote(req.business._id, document._id) : null
  ]);

  res.json({
    success: true,
    document: {
      ...serializeInvoice(document, req),
      ...(applications
        ? {
            remaining: Math.max(Number(document.total || 0) - Number(document.appliedAmount || 0), 0),
            applications: applications.map((application) => ({
              allocationId: application._id,
              invoiceId: application.invoice?._id || application.invoice,
              invoiceNumber: application.invoice?.invoiceNumber || application.invoice?.documentNumber || '',
              amount: application.amount,
              allocatedAt: application.allocatedAt
            }))
          }
        : {}),
      ...(rules.convertsTo
        ? {
            linkedInvoice: linkedInvoice
              ? { id: linkedInvoice._id, invoiceNumber: linkedInvoice.invoiceNumber || linkedInvoice.documentNumber, status: linkedInvoice.status }
              : null
          }
        : {}),
      ...(stockEffect ? { stockEffect } : {})
    }
  });
});

export const createDocument = asyncHandler(async (req, res) => {
  const documentType = documentTypeFrom(req);
  // A quotation, challan or credit note is a numbered sales document, so it costs a document
  // from the monthly quota exactly like an invoice does.
  const document = await meterDocument(req, () => createDocumentWorkflow({ req, documentType }), { res });

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
  const invoice = await meterDocument(req, () => convertDocumentWorkflow({ req, documentType }), { res });

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
