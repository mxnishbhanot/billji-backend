import { body } from 'express-validator';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logAudit } from '../../services/auditService.js';
import { emitBusinessEvent } from '../../services/socketService.js';
import { IMPORT_ENTITIES, IMPORT_TYPES } from './fields.js';
import { MAX_IMPORT_ROWS, analyzeImport, commitImport } from './service.js';

export const importRules = [
  body('type').isIn(IMPORT_TYPES).withMessage('Choose what you are importing'),
  body('csv').isString().notEmpty().withMessage('Attach a CSV file'),
  body('columnMap').optional({ nullable: true }).isObject(),
  body('mode').optional({ checkFalsy: true }).isIn(['skip', 'update'])
];

/** The field catalogue, so the mapping UI does not hard-code our column names. */
export const importFields = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    maxRows: MAX_IMPORT_ROWS,
    types: IMPORT_TYPES.map((type) => ({
      type,
      label: IMPORT_ENTITIES[type].label,
      duplicateLabel: IMPORT_ENTITIES[type].duplicateLabel,
      fields: IMPORT_ENTITIES[type].fields.map(({ name, label, required, aliases }) => ({
        name,
        label,
        required: Boolean(required),
        example: aliases[0]
      }))
    }))
  });
});

export const previewImport = asyncHandler(async (req, res) => {
  const analysis = await analyzeImport({
    businessId: req.business._id,
    type: req.body.type,
    csv: req.body.csv,
    columnMap: req.body.columnMap
  });

  // Rows are only needed for the on-screen preview; the commit re-parses the file itself.
  const { rows, ...summary } = analysis;
  res.json({ success: true, ...summary });
});

export const runImport = asyncHandler(async (req, res) => {
  const result = await commitImport({
    businessId: req.business._id,
    actorId: req.user._id,
    type: req.body.type,
    csv: req.body.csv,
    columnMap: req.body.columnMap,
    mode: req.body.mode
  });

  void logAudit(req, {
    action: 'import.completed',
    resourceType: req.body.type === 'customers' ? 'customer' : 'product',
    metadata: { type: result.type, created: result.created, updated: result.updated, failed: result.failed }
  });

  const changed = req.body.type === 'customers' ? 'customers:changed' : 'products:changed';
  emitBusinessEvent(req.business._id, changed, { reason: 'imported' });

  res.status(201).json({ success: true, ...result });
});
