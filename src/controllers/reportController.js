import { query } from 'express-validator';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getReportSummary } from '../services/reportService.js';

export const reportQueryRules = [
  query('from').optional({ checkFalsy: true }).isISO8601(),
  query('to').optional({ checkFalsy: true }).isISO8601().custom((to, { req }) => {
    if (!req.query.from) return true;
    return new Date(to) >= new Date(req.query.from);
  }).withMessage('To date must be on or after from date')
];

export const summary = asyncHandler(async (req, res) => {
  const report = await getReportSummary(req.user._id, { from: req.query.from, to: req.query.to });
  res.json({ success: true, report });
});
