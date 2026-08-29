import { body, query } from 'express-validator';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getSubscription } from '../../services/subscriptionService.js';
import {
  applyReferral,
  eligibilityFor,
  ensureReferralCode,
  referredUsersFor,
  rewardsFor,
  serializeReferral,
  statsFor,
  validateCode
} from './service.js';

export const applyReferralRules = [
  body('code').trim().isLength({ min: 4, max: 40 }).withMessage('Enter a valid referral code')
];

export const validateReferralRules = [
  body('code').trim().isLength({ min: 4, max: 40 }).withMessage('Enter a valid referral code')
];

export const pageRules = [
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 })
];

const paging = (req) => ({
  page: Number(req.query.page) || 1,
  limit: Math.min(Number(req.query.limit) || 20, 50)
});

export const myReferral = asyncHandler(async (req, res) => {
  const [code, stats] = await Promise.all([ensureReferralCode(req.business._id), statsFor(req.business._id)]);
  res.json({ code, stats });
});

export const myStats = asyncHandler(async (req, res) => {
  res.json({ stats: await statsFor(req.business._id) });
});

export const myRewards = asyncHandler(async (req, res) => {
  res.json({ rewards: await rewardsFor({ businessId: req.business._id, ...paging(req) }) });
});

export const myReferrals = asyncHandler(async (req, res) => {
  res.json({ referrals: await referredUsersFor({ businessId: req.business._id, ...paging(req) }) });
});

export const myEligibility = asyncHandler(async (req, res) => {
  res.json(await eligibilityFor(req.business._id));
});

export const validateReferralCode = asyncHandler(async (req, res) => {
  res.json(await validateCode(req.body.code));
});

/**
 * The one write. Also the sync push handler for `referral:create`, which is why it reads clientId
 * from the body and answers with the same `{ referral, subscription }` shape either way — the
 * offline path must not be a second implementation of this decision.
 */
export const apply = asyncHandler(async (req, res) => {
  const { referral } = await applyReferral({
    business: req.business,
    code: req.body.code,
    clientId: req.body.clientId || null
  });

  res.status(201).json({
    referral: serializeReferral(referral),
    subscription: await getSubscription(req.business._id)
  });
});
