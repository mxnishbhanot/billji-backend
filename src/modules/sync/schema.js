import { body, query } from 'express-validator';
import { MAX_PULL_LIMIT, MAX_PUSH_OPERATIONS } from './protocol.js';
import { PUSH_ENTITIES, SYNC_COLLECTION_NAMES } from './registry.js';

export const pullRules = [
  query('collection').isIn(SYNC_COLLECTION_NAMES).withMessage('Unknown sync collection'),
  query('cursor').optional({ checkFalsy: true }).isString().isLength({ max: 256 }),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: MAX_PULL_LIMIT }).toInt()
];

export const bootstrapRules = [
  query('scope').optional({ checkFalsy: true }).isIn(['phase1', 'phase2']),
  query('collection').optional({ checkFalsy: true }).isIn(SYNC_COLLECTION_NAMES),
  query('cursor').optional({ checkFalsy: true }).isString().isLength({ max: 256 }),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: MAX_PULL_LIMIT }).toInt(),
  // Size of the phase-2 history window. 12 months is the design default.
  query('months').optional({ checkFalsy: true }).isInt({ min: 1, max: 60 }).toInt()
];

export const deviceRules = [
  // Normally read from X-Device-Id; accepted in the body so a first registration can happen
  // before the header is wired.
  body('deviceId').optional({ nullable: true }).isString().isLength({ min: 8, max: 64 }),
  body('name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('platform').optional({ nullable: true }).isIn(['android', 'ios', 'web', 'desktop']),
  body('documentType').optional({ checkFalsy: true }).isIn(['invoice', 'quotation', 'delivery_challan', 'credit_note'])
];

// The envelope only. Each operation's payload is validated by the same express-validator
// chain the online route uses, at dispatch time — an offline client is an untrusted client.
export const pushRules = [
  body('deviceId').optional({ nullable: true }).isString().isLength({ max: 64 }),
  body('ops')
    .isArray({ min: 1, max: MAX_PUSH_OPERATIONS })
    .withMessage(`ops must contain between 1 and ${MAX_PUSH_OPERATIONS} operations`),
  body('ops.*.opId').isString().isLength({ min: 8, max: 64 }).withMessage('opId is required'),
  body('ops.*.entity').isIn(PUSH_ENTITIES).withMessage('Unknown sync entity'),
  body('ops.*.opType').isIn(['create', 'update', 'delete']),
  body('ops.*.clientId').optional({ nullable: true }).isString().isLength({ max: 64 }),
  body('ops.*.targetId').optional({ nullable: true }).isMongoId(),
  body('ops.*.payload').optional({ nullable: true }).isObject()
];
