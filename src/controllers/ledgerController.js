import { query } from 'express-validator';
import LedgerEntry, { LEDGER_ACCOUNTS } from '../models/LedgerEntry.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPagination, paginationMeta } from '../utils/pagination.js';

export const ledgerQueryRules = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  query('account').optional({ checkFalsy: true }).isIn(LEDGER_ACCOUNTS),
  query('customerId').optional({ checkFalsy: true }).isMongoId()
];

export const listLedgerEntries = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query, { defaultLimit: 20, maxLimit: 50 });
  const filter = { business: req.business._id };
  if (req.query.account) filter.account = req.query.account;
  if (req.query.customerId) filter.customer = req.query.customerId;

  const [ledgerEntries, total] = await Promise.all([
    LedgerEntry.find(filter)
      .sort({ entryDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('customer', 'name')
      .lean(),
    LedgerEntry.countDocuments(filter)
  ]);

  res.json({ success: true, ledgerEntries, pagination: paginationMeta({ page, limit, total }) });
});
