import Business from '../models/Business.js';
import BusinessMember from '../models/BusinessMember.js';
import Session from '../models/Session.js';
import User from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifyToken } from '../utils/jwt.js';

export const protect = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    throw new ApiError(401, 'Authentication required');
  }

  const decoded = verifyToken(token);
  const user = await User.findById(decoded.sub).select('-password');

  if (!user) {
    throw new ApiError(401, 'Invalid authentication token');
  }

  let session = null;
  if (decoded.sid) {
    session = await Session.findOne({
      _id: decoded.sid,
      user: user._id,
      revokedAt: null,
      refreshTokenExpiresAt: { $gt: new Date() }
    });

    if (!session) {
      throw new ApiError(401, 'Session expired or revoked');
    }

    session.lastUsedAt = new Date();
    void session.save().catch(() => {});
  }

  let business = user.defaultBusiness ? await Business.findOne({ _id: user.defaultBusiness, status: 'active' }) : null;
  let membership = business
    ? await BusinessMember.findOne({ business: business._id, user: user._id, status: 'active' })
    : null;

  if (!business || !membership) {
    membership = await BusinessMember.findOne({ user: user._id, status: 'active' }).sort({ joinedAt: 1 });
    business = membership ? await Business.findOne({ _id: membership.business, status: 'active' }) : null;
  }

  if (!business || !membership) {
    throw new ApiError(403, 'No active business membership found');
  }

  req.user = user;
  req.business = business;
  req.membership = membership;
  req.session = session;
  next();
});
