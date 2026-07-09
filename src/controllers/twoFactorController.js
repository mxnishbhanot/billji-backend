import { body } from 'express-validator';
import Business from '../models/Business.js';
import User from '../models/User.js';
import { isProduction } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { verifyChallengeToken } from '../utils/jwt.js';
import { logAudit } from '../services/auditService.js';
import { sessionResponse } from './authController.js';
import {
  createAndSendEmailChallenge,
  issueTrustedDevice,
  revokeTrustedDevices,
  verifyEmailChallenge
} from '../services/twoFactorAuth.js';
import {
  buildOtpauthUrl,
  consumeBackupCode,
  countUnusedBackupCodes,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpSecret,
  verifyTotp
} from '../services/twoFactorService.js';

// --- validators ---
const codeRule = body('code').isString().trim().notEmpty().withMessage('Verification code is required');

export const totpEnableRules = [codeRule];
export const emailEnableRules = [codeRule];
export const manageRules = [codeRule];
export const verifyRules = [
  body('challengeToken').isString().trim().notEmpty().withMessage('Challenge token is required'),
  codeRule,
  body('rememberDevice').optional().isBoolean()
];
export const resendRules = [
  body('challengeToken').isString().trim().notEmpty().withMessage('Challenge token is required')
];

// req.user (from `protect`) omits the select:false 2FA secrets; reload them when a
// flow must decrypt the TOTP secret or check backup codes.
const loadUserWithSecrets = (userId) =>
  User.findById(userId).select('+twoFactor.totpSecret +twoFactor.pendingTotpSecret +twoFactor.backupCodes');

const maskEmail = (email = '') => {
  const [local, domain] = String(email).split('@');
  if (!domain) return email;
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(local.length - 2, 2))}@${domain}`;
};

const twoFactorStatus = (user) => ({
  method: user.twoFactor?.method || 'none',
  enabled: (user.twoFactor?.method || 'none') !== 'none',
  enabledAt: user.twoFactor?.enabledAt || null,
  pendingMethod: user.twoFactor?.pendingMethod || null
});

// GET /auth/2fa/status
export const getStatus = asyncHandler(async (req, res) => {
  const user = await loadUserWithSecrets(req.user._id);
  res.json({
    success: true,
    twoFactor: {
      ...twoFactorStatus(user),
      backupCodesRemaining: countUnusedBackupCodes(user.twoFactor?.backupCodes)
    }
  });
});

// Guard: only one active method at a time. To switch, disable first.
const assertNotEnrolled = (user) => {
  if ((user.twoFactor?.method || 'none') !== 'none') {
    throw new ApiError(409, 'Two-factor authentication is already enabled. Turn it off before switching methods.');
  }
};

// POST /auth/2fa/totp/setup — stage a secret, return provisioning data for the QR.
export const totpSetup = asyncHandler(async (req, res) => {
  const user = await loadUserWithSecrets(req.user._id);
  assertNotEnrolled(user);

  const secret = generateTotpSecret();
  user.twoFactor.pendingMethod = 'totp';
  user.twoFactor.pendingTotpSecret = encryptSecret(secret);
  await user.save();

  res.json({
    success: true,
    // otpauthUrl feeds the QR code; secret is the manual-entry fallback.
    otpauthUrl: buildOtpauthUrl({ secret, accountName: user.email }),
    secret
  });
});

// POST /auth/2fa/totp/enable — verify a code against the staged secret, activate.
export const totpEnable = asyncHandler(async (req, res) => {
  const user = await loadUserWithSecrets(req.user._id);
  if (user.twoFactor.pendingMethod !== 'totp' || !user.twoFactor.pendingTotpSecret) {
    throw new ApiError(400, 'Start authenticator setup first');
  }

  const secret = decryptSecret(user.twoFactor.pendingTotpSecret);
  if (!verifyTotp({ secret, token: req.body.code })) {
    throw new ApiError(422, 'That code is incorrect or expired. Try the current code from your app.');
  }

  const { plain, hashed } = generateBackupCodes();
  user.twoFactor.method = 'totp';
  user.twoFactor.totpSecret = user.twoFactor.pendingTotpSecret;
  user.twoFactor.pendingTotpSecret = null;
  user.twoFactor.pendingMethod = null;
  user.twoFactor.backupCodes = hashed;
  user.twoFactor.enabledAt = new Date();
  await user.save();

  void logAudit(req, { action: 'auth.2fa_enabled', resourceType: 'user', resourceId: user._id, metadata: { method: 'totp' } });
  res.json({ success: true, method: 'totp', backupCodes: plain });
});

// POST /auth/2fa/email/setup — stage email method, send an enrollment code.
export const emailSetup = asyncHandler(async (req, res) => {
  const user = await loadUserWithSecrets(req.user._id);
  assertNotEnrolled(user);

  user.twoFactor.pendingMethod = 'email';
  await user.save();
  const devCode = await createAndSendEmailChallenge({ user, purpose: 'enroll', req });

  res.json({ success: true, email: maskEmail(user.email), devCode: !isProduction ? devCode : undefined });
});

// POST /auth/2fa/email/enable — verify the enrollment code, activate.
export const emailEnable = asyncHandler(async (req, res) => {
  const user = await loadUserWithSecrets(req.user._id);
  if (user.twoFactor.pendingMethod !== 'email') {
    throw new ApiError(400, 'Start email verification setup first');
  }

  const ok = await verifyEmailChallenge({ user, purpose: 'enroll', code: req.body.code });
  if (!ok) throw new ApiError(422, 'That code is incorrect or expired.');

  const { plain, hashed } = generateBackupCodes();
  user.twoFactor.method = 'email';
  user.twoFactor.pendingMethod = null;
  user.twoFactor.backupCodes = hashed;
  user.twoFactor.enabledAt = new Date();
  await user.save();

  void logAudit(req, { action: 'auth.2fa_enabled', resourceType: 'user', resourceId: user._id, metadata: { method: 'email' } });
  res.json({ success: true, method: 'email', backupCodes: plain });
});

// POST /auth/2fa/send-code — email 2FA users request a code to authorize a
// sensitive management op (disable / regenerate). TOTP users use their app code.
export const sendManageCode = asyncHandler(async (req, res) => {
  const user = await loadUserWithSecrets(req.user._id);
  const method = user.twoFactor?.method || 'none';
  if (method === 'none') throw new ApiError(400, 'Two-factor authentication is not enabled');
  if (method !== 'email') throw new ApiError(400, 'Enter the current code from your authenticator app');

  const devCode = await createAndSendEmailChallenge({ user, purpose: 'manage', req });
  res.json({ success: true, email: maskEmail(user.email), devCode: !isProduction ? devCode : undefined });
});

// Verify a code against the user's ACTIVE factor, or a backup code as fallback.
// Saves the user doc when a backup code is consumed. Returns true/false.
const verifyActiveFactor = async ({ user, code, purpose }) => {
  const method = user.twoFactor?.method || 'none';
  let ok = false;
  if (method === 'totp') {
    ok = verifyTotp({ secret: decryptSecret(user.twoFactor.totpSecret), token: code });
  } else if (method === 'email') {
    ok = await verifyEmailChallenge({ user, purpose, code });
  }
  if (ok) return true;
  if (consumeBackupCode(user.twoFactor.backupCodes, code)) {
    await user.save();
    return true;
  }
  return false;
};

// POST /auth/2fa/disable
export const disable = asyncHandler(async (req, res) => {
  const user = await loadUserWithSecrets(req.user._id);
  if ((user.twoFactor?.method || 'none') === 'none') throw new ApiError(400, 'Two-factor authentication is not enabled');

  const ok = await verifyActiveFactor({ user, code: req.body.code, purpose: 'manage' });
  if (!ok) throw new ApiError(422, 'That code is incorrect or expired.');

  user.twoFactor.method = 'none';
  user.twoFactor.totpSecret = null;
  user.twoFactor.pendingTotpSecret = null;
  user.twoFactor.pendingMethod = null;
  user.twoFactor.backupCodes = [];
  user.twoFactor.enabledAt = null;
  await user.save();
  await revokeTrustedDevices(user._id);

  void logAudit(req, { action: 'auth.2fa_disabled', resourceType: 'user', resourceId: user._id });
  res.json({ success: true, method: 'none' });
});

// POST /auth/2fa/backup-codes/regenerate
export const regenerateBackupCodes = asyncHandler(async (req, res) => {
  const user = await loadUserWithSecrets(req.user._id);
  if ((user.twoFactor?.method || 'none') === 'none') throw new ApiError(400, 'Two-factor authentication is not enabled');

  const ok = await verifyActiveFactor({ user, code: req.body.code, purpose: 'manage' });
  if (!ok) throw new ApiError(422, 'That code is incorrect or expired.');

  const { plain, hashed } = generateBackupCodes();
  user.twoFactor.backupCodes = hashed;
  await user.save();

  void logAudit(req, { action: 'auth.2fa_backup_regenerated', resourceType: 'user', resourceId: user._id });
  res.json({ success: true, backupCodes: plain });
});

// POST /auth/2fa/verify — the second step of login. Consumes the challenge token,
// verifies the code, then issues a real session (optionally remembering the device).
export const verify = asyncHandler(async (req, res) => {
  let decoded;
  try {
    decoded = verifyChallengeToken(req.body.challengeToken);
  } catch {
    throw new ApiError(401, 'Your verification session expired. Please sign in again.');
  }

  const user = await loadUserWithSecrets(decoded.sub);
  if (!user || (user.twoFactor?.method || 'none') === 'none') {
    throw new ApiError(401, 'Your verification session expired. Please sign in again.');
  }

  const ok = await verifyActiveFactor({ user, code: req.body.code, purpose: 'login' });
  if (!ok) throw new ApiError(422, 'That code is incorrect or expired.');

  const business = await Business.findById(user.defaultBusiness);
  const session = await sessionResponse({ req, user, business });

  let trustedDeviceToken;
  if (req.body.rememberDevice) {
    trustedDeviceToken = await issueTrustedDevice({ user, req });
  }

  void logAudit(req, { action: 'auth.2fa_verified', resourceType: 'user', resourceId: user._id });
  res.json({ ...session, trustedDeviceToken });
});

// POST /auth/2fa/resend — resend the email login code for an in-flight challenge.
export const resendLoginCode = asyncHandler(async (req, res) => {
  let decoded;
  try {
    decoded = verifyChallengeToken(req.body.challengeToken);
  } catch {
    throw new ApiError(401, 'Your verification session expired. Please sign in again.');
  }
  if (decoded.method !== 'email') throw new ApiError(400, 'This sign-in does not use email codes');

  const user = await User.findById(decoded.sub);
  if (!user || user.twoFactor?.method !== 'email') {
    throw new ApiError(401, 'Your verification session expired. Please sign in again.');
  }

  const devCode = await createAndSendEmailChallenge({ user, purpose: 'login', req });
  res.json({ success: true, email: maskEmail(user.email), devCode: !isProduction ? devCode : undefined });
});
