import { body, param, query } from 'express-validator';
import Draft from '../models/Draft.js';
import { SALES_DOCUMENT_TYPES } from '../models/SalesDocument.js';
import { DOMAIN_EVENTS, publishDomainEvent } from '../services/eventBus.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const DEFAULT_DOCUMENT_TYPE = 'invoice';

export const draftRules = [
  body('documentType').optional().isIn(SALES_DOCUMENT_TYPES),
  body('schemaVersion').optional().isInt({ min: 1 }).toInt(),
  body('payload').optional().isObject().withMessage('Draft payload must be an object'),
  body('dirty').optional().isBoolean().toBoolean(),
  body('lastEditedAt').optional().isISO8601().withMessage('lastEditedAt must be an ISO date')
];

export const draftQueryRules = [
  query('documentType').optional({ checkFalsy: true }).isIn(SALES_DOCUMENT_TYPES)
];

export const draftIdRules = [
  param('localDraftId').trim().notEmpty().withMessage('localDraftId is required').isLength({ max: 120 })
];

const normalizeDraft = (draft) => ({
  _id: draft._id,
  localDraftId: draft.localDraftId,
  serverDraftId: draft._id,
  businessId: draft.business,
  documentType: draft.documentType,
  schemaVersion: draft.schemaVersion,
  payload: draft.payload,
  dirty: draft.dirty,
  lastEditedAt: draft.lastEditedAt,
  lastSyncedAt: draft.lastSyncedAt,
  createdAt: draft.createdAt,
  updatedAt: draft.updatedAt
});

export const listDrafts = asyncHandler(async (req, res) => {
  const filter = { business: req.business._id, user: req.user._id };
  if (req.query.documentType) filter.documentType = req.query.documentType;

  const drafts = await Draft.find(filter).sort({ lastEditedAt: -1 });
  res.json({ success: true, drafts: drafts.map(normalizeDraft) });
});

export const upsertDraft = asyncHandler(async (req, res) => {
  const now = new Date();
  const incomingEditedAt = req.body.lastEditedAt ? new Date(req.body.lastEditedAt) : now;
  const update = {
    business: req.business._id,
    user: req.user._id,
    localDraftId: req.params.localDraftId,
    documentType: req.body.documentType || DEFAULT_DOCUMENT_TYPE,
    schemaVersion: req.body.schemaVersion || 1,
    payload: req.body.payload || {},
    dirty: Boolean(req.body.dirty),
    lastEditedAt: incomingEditedAt,
    lastSyncedAt: now
  };

  const draft = await Draft.findOneAndUpdate(
    { business: req.business._id, user: req.user._id, localDraftId: req.params.localDraftId },
    update,
    { new: true, runValidators: true, upsert: true, setDefaultsOnInsert: true }
  );

  await publishDomainEvent({
    business: req.business._id,
    actor: req.user._id,
    eventType: DOMAIN_EVENTS.draftSaved,
    aggregateType: 'draft',
    aggregateId: draft._id,
    payload: {
      localDraftId: draft.localDraftId,
      documentType: draft.documentType,
      schemaVersion: draft.schemaVersion,
      dirty: draft.dirty,
      lastEditedAt: draft.lastEditedAt
    },
    dedupeKey: `${DOMAIN_EVENTS.draftSaved}:${draft._id}:${new Date(draft.updatedAt || now).getTime()}`
  });

  res.json({ success: true, draft: normalizeDraft(draft) });
});

export const deleteDraft = asyncHandler(async (req, res) => {
  await Draft.findOneAndDelete({ business: req.business._id, user: req.user._id, localDraftId: req.params.localDraftId });
  res.json({ success: true, message: 'Draft discarded' });
});
