import { body } from 'express-validator';
import Business from '../models/Business.js';
import BusinessMember from '../models/BusinessMember.js';
import { assertBusinessCreationAllowed } from '../middlewares/entitlement.js';
import { logAudit } from '../services/auditService.js';
import { createBusinessForOwner } from '../services/businessService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { publicUser } from './authController.js';

export const createBusinessRules = [
  body('businessName').trim().notEmpty().withMessage('Business name is required').isLength({ max: 120 }).withMessage('Business name must be 120 characters or fewer'),
  body('email').optional({ nullable: true, checkFalsy: true }).isEmail().withMessage('Valid email is required')
];

/**
 * Creates a workspace the caller owns, and switches them into it.
 *
 * No requirePermission: this is not an action inside the current workspace, so the caller's role
 * there is irrelevant. A viewer in someone else's business is exactly who this endpoint is for —
 * they cannot buy a plan for that business, and this is the path to one they can.
 *
 * The FIRST owned workspace is always free and ungated. Gating it on the current workspace's plan
 * would mean a member's ability to start their own business depended on what their employer had
 * paid for, which is the opposite of the intent. Only the second and later are metered, and then
 * against the caller's OWN plan — never the plan of a business they merely belong to.
 */
export const createBusiness = asyncHandler(async (req, res) => {
  const businessName = req.body.businessName.trim();

  // Double-tap guard, standing in for the idempotency() middleware — see businessRoutes.js for why
  // that one cannot work here. Creating the same-named workspace twice is a duplicate, never an
  // intent, and the second one would silently eat a slot of the caller's `businesses` allowance.
  const duplicate = await Business.findOne({ owner: req.user._id, businessName, status: 'active' });
  if (duplicate) return switchedInto(req, res, duplicate, 200);

  const ownedCount = await Business.countDocuments({ owner: req.user._id, status: 'active' });

  if (ownedCount > 0) {
    // Whose plan pays for this? The current workspace's only if the caller owns it; otherwise the
    // oldest workspace they do own. Never req.business by default — see the note above.
    const ownsCurrent = String(req.business?.owner) === String(req.user._id);
    const gateBusiness = ownsCurrent
      ? req.business
      : await Business.findOne({ owner: req.user._id, status: 'active' }).sort({ createdAt: 1 });

    await assertBusinessCreationAllowed({ req, res, ownedCount, business: gateBusiness });
  }

  const business = await createBusinessForOwner({
    user: req.user,
    businessName,
    email: req.body.email || req.user.email,
    note: 'business.created'
  });

  void logAudit(req, { action: 'business.created', resourceType: 'business', resourceId: business._id });

  return switchedInto(req, res, business, 201);
});

/**
 * Creating a workspace switches into it, so the response is the same user payload
 * POST /auth/business/switch returns and the client adopts it through the one path it already has.
 *
 * The membership is re-read rather than synthesized: canManageBilling is computed from it, and a
 * money decision must never be made from an object this function invented.
 */
const switchedInto = async (req, res, business, statusCode) => {
  req.user.defaultBusiness = business._id;
  await req.user.save();

  const membership = await BusinessMember.findOne({ business: business._id, user: req.user._id, status: 'active' });

  return res.status(statusCode).json({ success: true, user: await publicUser(req.user, business, membership) });
};
