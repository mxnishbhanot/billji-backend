import { query } from 'express-validator';
import AuditLog from '../models/AuditLog.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, paginationMeta } from '../utils/pagination.js';

export const auditQueryRules = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  query('action').optional({ checkFalsy: true }).isString().isLength({ max: 120 }),
  query('resourceType').optional({ checkFalsy: true }).isString().isLength({ max: 80 })
];

export const listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 });
  const filter = { business: req.business._id };
  if (req.query.action) filter.action = req.query.action;
  if (req.query.resourceType) filter.resourceType = req.query.resourceType;

  const [auditLogs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('user', 'name email')
      .lean(),
    AuditLog.countDocuments(filter)
  ]);

  res.json({ success: true, auditLogs, pagination: paginationMeta({ page, limit, total }) });
});
