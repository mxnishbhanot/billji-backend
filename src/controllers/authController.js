import crypto from 'crypto';
import { body, param } from 'express-validator';
import Business from '../models/Business.js';
import BusinessMember from '../models/BusinessMember.js';
import PasswordResetToken from '../models/PasswordResetToken.js';
import Session from '../models/Session.js';
import User from '../models/User.js';
import { env, isProduction } from '../config/env.js';
import { permissionsForMembership } from '../middlewares/authorization.js';
import { logAudit } from '../services/auditService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { refreshTokenExpiresAt, signAccessToken, signRefreshToken, tokenHash, verifyRefreshToken } from '../utils/jwt.js';

const businessProfile = (business) => ({
  businessName: business?.businessName || 'QuickInvoice Business',
  logoUrl: business?.logoUrl || '',
  gstNumber: business?.gstNumber || '',
  phone: business?.phone || '',
  countryCode: business?.countryCode || '+91',
  email: business?.email || '',
  website: business?.website || '',
  address: business?.address || '',
  city: business?.city || '',
  pinCode: business?.pinCode || '',
  state: business?.state || '',
  invoicePrefix: business?.invoicePrefix || 'INV',
  panNumber: business?.panNumber || '',
  taxSettings: {
    defaultRate: business?.taxSettings?.defaultRate ?? 0,
    pricesIncludeTax: business?.taxSettings?.pricesIncludeTax ?? false,
    compoundTax: business?.taxSettings?.compoundTax ?? false
  },
  theme: business?.theme || 'light'
});

const publicUser = async (user, business, membership = null) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  businessId: business?._id || user.defaultBusiness || null,
  roleKey: membership?.roleKey || 'owner',
  permissions: await permissionsForMembership(membership || { roleKey: 'owner' }),
  businessProfile: businessProfile(business),
  createdAt: user.createdAt
});

const requestIp = (req) => req.ip || req.headers['x-forwarded-for']?.split(',')?.[0]?.trim() || '';
const requestUserAgent = (req) => req.get('user-agent') || '';

const sessionResponse = async ({ req, user, business }) => {
  if (!business) throw new ApiError(403, 'No active business found for this account');
  const membership = await BusinessMember.findOne({ business: business._id, user: user._id, status: 'active' });
  const refreshTokenId = crypto.randomUUID();
  const session = await Session.create({
    business: business._id,
    user: user._id,
    refreshTokenHash: 'pending',
    refreshTokenId,
    refreshTokenExpiresAt: refreshTokenExpiresAt(),
    userAgent: requestUserAgent(req),
    ipAddress: requestIp(req),
    lastUsedAt: new Date()
  });
  const accessToken = signAccessToken({ userId: user._id, sessionId: session._id });
  const refreshToken = signRefreshToken({ userId: user._id, sessionId: session._id, refreshTokenId });
  session.refreshTokenHash = tokenHash(refreshToken);
  await session.save();

  return {
    success: true,
    token: accessToken,
    accessToken,
    refreshToken,
    sessionId: session._id,
    user: await publicUser(user, business, membership)
  };
};

export const registerRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 80 }),
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
];

export const loginRules = [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required')
];

export const refreshRules = [
  body('refreshToken').notEmpty().withMessage('Refresh token is required')
];

export const resetRequestRules = [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail()
];

export const resetConfirmRules = [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
];

export const sessionIdRules = [
  param('sessionId').isMongoId().withMessage('Valid session id is required')
];

export const settingsRules = [
  body('businessName').optional().trim().isLength({ min: 1, max: 120 }),
  body('logoUrl').optional({ nullable: true, checkFalsy: true }).isString(),
  body('gstNumber').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 32 }),
  body('phone').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 24 }),
  body('countryCode').optional({ nullable: true, checkFalsy: true }).trim().matches(/^\+\d{1,7}$/).withMessage('Enter a valid country code'),
  body('email').optional({ nullable: true, checkFalsy: true }).isEmail().normalizeEmail(),
  body('website').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 180 }).isURL({ require_protocol: false }),
  body('address').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 500 }),
  body('city').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 80 }),
  body('pinCode').optional({ nullable: true, checkFalsy: true }).trim().matches(/^\d{6}$/).withMessage('PIN code must be 6 digits'),
  body('state').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 80 }),
  body('panNumber').optional({ nullable: true, checkFalsy: true }).trim().matches(/^[A-Z]{5}[0-9]{4}[A-Z]$/i).withMessage('Enter a valid PAN'),
  body('invoicePrefix').optional().trim().isLength({ min: 1, max: 12 }),
  body('theme').optional().isIn(['light', 'dark']),
  body('taxSettings').optional().isObject().withMessage('taxSettings must be an object'),
  body('taxSettings.defaultRate').optional().isFloat({ min: 0, max: 100 }).withMessage('Default tax rate must be between 0 and 100'),
  body('taxSettings.pricesIncludeTax').optional().isBoolean(),
  body('taxSettings.compoundTax').optional().isBoolean()
];

export const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const exists = await User.findOne({ email });

  if (exists) {
    throw new ApiError(409, 'An account with this email already exists');
  }

  const user = await User.create({
    name,
    email,
    password
  });
  const business = await Business.create({
    owner: user._id,
    businessName: `${name}'s Business`,
    email
  });
  await BusinessMember.create({
    business: business._id,
    user: user._id,
    roleKey: 'owner',
    joinedAt: new Date()
  });
  user.defaultBusiness = business._id;
  await user.save();

  const session = await sessionResponse({ req, user, business });
  void logAudit(req, { action: 'auth.registered', resourceType: 'user', resourceId: user._id });
  res.status(201).json(session);
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select('+password');

  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, 'Invalid email or password');
  }

  const business = await Business.findById(user.defaultBusiness);

  const session = await sessionResponse({ req, user, business });
  void logAudit(req, { action: 'auth.login', resourceType: 'user', resourceId: user._id });
  res.json(session);
});

export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, user: await publicUser(req.user, req.business, req.membership) });
});

export const refreshSession = asyncHandler(async (req, res) => {
  const decoded = verifyRefreshToken(req.body.refreshToken);
  if (decoded.typ !== 'refresh') throw new ApiError(401, 'Invalid refresh token');

  const session = await Session.findOne({
    _id: decoded.sid,
    user: decoded.sub,
    refreshTokenId: decoded.jti,
    refreshTokenHash: tokenHash(req.body.refreshToken),
    revokedAt: null,
    refreshTokenExpiresAt: { $gt: new Date() }
  });

  if (!session) throw new ApiError(401, 'Refresh token expired or revoked');

  const user = await User.findById(session.user).select('-password');
  const business = await Business.findOne({ _id: session.business, status: 'active' });
  const membership = business ? await BusinessMember.findOne({ business: business._id, user: user?._id, status: 'active' }) : null;
  if (!user || !business) throw new ApiError(401, 'Session user or business is no longer active');

  const refreshTokenId = crypto.randomUUID();
  const accessToken = signAccessToken({ userId: user._id, sessionId: session._id });
  const refreshToken = signRefreshToken({ userId: user._id, sessionId: session._id, refreshTokenId });
  session.refreshTokenId = refreshTokenId;
  session.refreshTokenHash = tokenHash(refreshToken);
  session.refreshTokenExpiresAt = refreshTokenExpiresAt();
  session.lastUsedAt = new Date();
  session.userAgent = requestUserAgent(req) || session.userAgent;
  session.ipAddress = requestIp(req) || session.ipAddress;
  await session.save();

  res.json({
    success: true,
    token: accessToken,
    accessToken,
    refreshToken,
    sessionId: session._id,
    user: await publicUser(user, business, membership)
  });
});

export const logout = asyncHandler(async (req, res) => {
  if (req.session) {
    req.session.revokedAt = new Date();
    req.session.revokedReason = 'logout';
    await req.session.save();
    void logAudit(req, { action: 'auth.logout', resourceType: 'session', resourceId: req.session._id });
  }

  res.json({ success: true });
});

export const listSessions = asyncHandler(async (req, res) => {
  const sessions = await Session.find({ user: req.user._id, revokedAt: null }).sort({ lastUsedAt: -1 }).select('-refreshTokenHash');
  res.json({
    success: true,
    sessions: sessions.map((session) => ({
      id: session._id,
      business: session.business,
      userAgent: session.userAgent,
      ipAddress: session.ipAddress,
      lastUsedAt: session.lastUsedAt,
      createdAt: session.createdAt,
      current: req.session ? String(session._id) === String(req.session._id) : false
    }))
  });
});

export const revokeSession = asyncHandler(async (req, res) => {
  const session = await Session.findOne({ _id: req.params.sessionId, user: req.user._id, revokedAt: null });
  if (!session) throw new ApiError(404, 'Session not found');

  session.revokedAt = new Date();
  session.revokedReason = 'user_revoked';
  await session.save();
  void logAudit(req, { action: 'auth.session_revoked', resourceType: 'session', resourceId: session._id });
  res.json({ success: true });
});

export const requestPasswordReset = asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.body.email });
  let resetToken = null;

  if (user) {
    resetToken = crypto.randomBytes(32).toString('hex');
    await PasswordResetToken.create({
      user: user._id,
      tokenHash: tokenHash(resetToken),
      expiresAt: new Date(Date.now() + env.passwordResetTtlMinutes * 60 * 1000),
      requestedIp: requestIp(req)
    });
    void logAudit(req, { action: 'auth.password_reset_requested', resourceType: 'user', resourceId: user._id });
  }

  res.json({
    success: true,
    message: 'If an account exists, a password reset link has been prepared.',
    resetToken: !isProduction ? resetToken : undefined
  });
});

export const confirmPasswordReset = asyncHandler(async (req, res) => {
  const reset = await PasswordResetToken.findOne({
    tokenHash: tokenHash(req.body.token),
    usedAt: null,
    expiresAt: { $gt: new Date() }
  });

  if (!reset) throw new ApiError(422, 'Password reset token is invalid or expired');

  const user = await User.findById(reset.user).select('+password');
  if (!user) throw new ApiError(404, 'User not found');

  user.password = req.body.password;
  await user.save();
  reset.usedAt = new Date();
  await reset.save();
  await Session.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'password_reset' });
  void logAudit(req, { action: 'auth.password_reset_confirmed', resourceType: 'user', resourceId: user._id });

  res.json({ success: true, message: 'Password updated. Please sign in again.' });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const allowed = ['businessName', 'logoUrl', 'gstNumber', 'phone', 'countryCode', 'email', 'website', 'address', 'city', 'pinCode', 'state', 'invoicePrefix', 'panNumber', 'theme'];

  allowed.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      req.business[field] = req.body[field] || '';
    }
  });

  if (req.body.taxSettings && typeof req.body.taxSettings === 'object') {
    const tax = req.body.taxSettings;
    if (tax.defaultRate !== undefined) req.business.taxSettings.defaultRate = Number(tax.defaultRate) || 0;
    if (tax.pricesIncludeTax !== undefined) req.business.taxSettings.pricesIncludeTax = Boolean(tax.pricesIncludeTax);
    if (tax.compoundTax !== undefined) req.business.taxSettings.compoundTax = Boolean(tax.compoundTax);
  }

  await req.business.save();
  const updatedFields = allowed.filter((field) => Object.prototype.hasOwnProperty.call(req.body, field)).concat(req.body.taxSettings ? ['taxSettings'] : []);
  void logAudit(req, { action: 'settings.updated', resourceType: 'business', resourceId: req.business._id, metadata: { fields: updatedFields } });

  res.json({ success: true, user: await publicUser(req.user, req.business, req.membership) });
});
