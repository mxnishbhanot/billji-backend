import crypto from 'crypto';
import TrustedDevice from '../models/TrustedDevice.js';
import TwoFactorChallenge from '../models/TwoFactorChallenge.js';
import { env, isProduction } from '../config/env.js';
import { isEmailEnabled } from '../config/resend.js';
import { ApiError } from '../utils/ApiError.js';
import { tokenHash } from '../utils/jwt.js';
import { generateEmailCode } from './twoFactorService.js';
import { sendTwoFactorCodeEmail } from './emailService.js';

// Max wrong email-code guesses before the code is burned.
const MAX_CHALLENGE_ATTEMPTS = 5;
const challengeTtlMs = () => env.twoFactor.challengeTtlMinutes * 60 * 1000;
const trustedTtlMs = () => env.twoFactor.trustedDeviceDays * 24 * 60 * 60 * 1000;

export const requestIp = (req) => req.ip || req.headers['x-forwarded-for']?.split(',')?.[0]?.trim() || '';
const requestUserAgent = (req) => req.get?.('user-agent') || '';
const requestDeviceName = (req) => (req.get?.('x-device-name') || '').trim().slice(0, 120);
const trustedDeviceToken = (req) => (req.get?.('x-trusted-device') || '').trim();

// --- Email OTP challenges ---

// Invalidate any earlier unused code for this purpose, mint a fresh one, store its
// hash, and email it. Returns the plaintext code (dev/test callers may surface it).
export const createAndSendEmailChallenge = async ({ user, purpose, req }) => {
  await TwoFactorChallenge.updateMany(
    { user: user._id, purpose, usedAt: null },
    { usedAt: new Date() }
  );

  let code = null;
  for (let i = 0; i < 5; i += 1) {
    code = generateEmailCode();
    try {
      await TwoFactorChallenge.create({
        user: user._id,
        codeHash: tokenHash(code),
        purpose,
        expiresAt: new Date(Date.now() + challengeTtlMs()),
        requestedIp: requestIp(req)
      });
      break;
    } catch (err) {
      if (err?.code === 11000) { code = null; continue; } // hash collision — redraw
      throw err;
    }
  }
  if (!code) throw new ApiError(500, 'Could not generate a verification code, please try again');

  // Never hit the real email provider under test, even if a key is present in .env.
  const canSend = isEmailEnabled() && process.env.NODE_ENV !== 'test';
  if (canSend) {
    await sendTwoFactorCodeEmail({
      to: user.email,
      name: user.name,
      code,
      ttlMinutes: env.twoFactor.challengeTtlMinutes,
      purpose
    });
  } else if (isProduction) {
    // No provider in production means the code can never reach the user — fail
    // loudly rather than stranding them at the verification step.
    throw new ApiError(503, 'Email service is not configured');
  }
  // Returned so non-production callers can echo it (dev/test convenience), exactly
  // as the password-reset flow does. Never surfaced in production responses.
  return code;
};

// Verifies a submitted email code for a purpose. Returns true on success (code
// consumed). Throws 429 when the attempt cap is hit. Returns false on a plain miss.
export const verifyEmailChallenge = async ({ user, purpose, code }) => {
  const challenge = await TwoFactorChallenge.findOne({
    user: user._id,
    purpose,
    usedAt: null,
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });

  if (!challenge) return false;

  if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    challenge.usedAt = new Date();
    await challenge.save();
    throw new ApiError(429, 'Too many incorrect attempts. Request a new code.');
  }

  if (challenge.codeHash !== tokenHash(String(code || '').trim())) {
    challenge.attempts += 1;
    await challenge.save();
    return false;
  }

  challenge.usedAt = new Date();
  await challenge.save();
  return true;
};

// --- Trusted devices ---

// Mint an opaque token for this device, persist its hash, and return the plaintext
// for the client to store and send back as x-trusted-device on future logins.
export const issueTrustedDevice = async ({ user, req }) => {
  const token = crypto.randomBytes(32).toString('hex');
  await TrustedDevice.create({
    user: user._id,
    tokenHash: tokenHash(token),
    expiresAt: new Date(Date.now() + trustedTtlMs()),
    deviceName: requestDeviceName(req),
    userAgent: requestUserAgent(req),
    ipAddress: requestIp(req),
    lastUsedAt: new Date()
  });
  return token;
};

// True when the request carries a valid, unexpired trusted-device token for this
// user. Bumps lastUsedAt as a side effect.
export const isTrustedDevice = async ({ user, req }) => {
  const token = trustedDeviceToken(req);
  if (!token) return false;
  const device = await TrustedDevice.findOne({
    user: user._id,
    tokenHash: tokenHash(token),
    expiresAt: { $gt: new Date() }
  });
  if (!device) return false;
  device.lastUsedAt = new Date();
  void device.save().catch(() => {});
  return true;
};

// Drop all remembered devices for a user (on disabling 2FA or password reset).
export const revokeTrustedDevices = (userId) => TrustedDevice.deleteMany({ user: userId });
