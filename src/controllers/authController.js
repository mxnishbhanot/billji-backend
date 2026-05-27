import { body } from 'express-validator';
import User from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { signToken } from '../utils/jwt.js';

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  businessProfile: user.businessProfile,
  createdAt: user.createdAt
});

export const registerRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 80 }),
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
];

export const loginRules = [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required')
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
  body('theme').optional().isIn(['light', 'dark'])
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
    password,
    businessProfile: {
      businessName: `${name}'s Business`,
      email
    }
  });

  const token = signToken(user._id);

  res.status(201).json({ success: true, token, user: publicUser(user) });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select('+password');

  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, 'Invalid email or password');
  }

  const token = signToken(user._id);

  res.json({ success: true, token, user: publicUser(user) });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, user: publicUser(req.user) });
});

export const updateSettings = asyncHandler(async (req, res) => {
  const allowed = ['businessName', 'logoUrl', 'gstNumber', 'phone', 'countryCode', 'email', 'website', 'address', 'city', 'pinCode', 'state', 'invoicePrefix', 'panNumber', 'theme'];
  const nextProfile = { ...req.user.businessProfile.toObject() };

  allowed.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      nextProfile[field] = req.body[field] || '';
    }
  });

  req.user.businessProfile = nextProfile;
  await req.user.save();

  res.json({ success: true, user: publicUser(req.user) });
});
