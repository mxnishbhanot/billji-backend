import crypto from 'crypto';
import otplib from 'otplib';
import { env } from '../config/env.js';
import { tokenHash } from '../utils/jwt.js';

const { authenticator } = otplib;

// Allow the code from the adjacent 30s step on each side, so a small clock skew
// between the phone and server doesn't reject a valid code.
authenticator.options = { window: 1 };

const BACKUP_CODE_COUNT = 10;
const AES_ALGO = 'aes-256-gcm';

// 32-byte key for encrypting TOTP secrets at rest. Prefer an explicit
// TWO_FACTOR_ENC_KEY (64-hex or base64); otherwise derive deterministically from
// JWT_SECRET so dev works with no extra config. Cached after first derivation.
let cachedKey = null;
const encryptionKey = () => {
  if (cachedKey) return cachedKey;
  const raw = env.twoFactor.encKey;
  if (raw) {
    let buf = null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
    else {
      const b64 = Buffer.from(raw, 'base64');
      if (b64.length === 32) buf = b64;
    }
    if (!buf) throw new Error('TWO_FACTOR_ENC_KEY must be 32 bytes (64 hex chars or base64)');
    cachedKey = buf;
  } else {
    cachedKey = crypto.scryptSync(env.jwtSecret, 'billji-2fa-totp', 32);
  }
  return cachedKey;
};

// Encrypted layout: base64(iv).base64(authTag).base64(ciphertext). Any tampering
// fails the GCM auth check on decrypt.
export const encryptSecret = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
};

export const decryptSecret = (payload) => {
  const [ivB64, tagB64, ctB64] = String(payload || '').split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted secret');
  const decipher = crypto.createDecipheriv(AES_ALGO, encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
};

// --- TOTP (authenticator app) ---

export const generateTotpSecret = () => authenticator.generateSecret();

export const buildOtpauthUrl = ({ secret, accountName }) =>
  authenticator.keyuri(accountName, env.twoFactor.issuer, secret);

// Strip spaces the user may paste from an authenticator app, then verify.
export const verifyTotp = ({ secret, token }) => {
  const normalized = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  try {
    return authenticator.check(normalized, secret);
  } catch {
    return false;
  }
};

// --- Email OTP codes ---

export const generateEmailCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

// --- Backup / recovery codes ---

// e.g. "3f9ac-1b7de". Grouped for readability; hyphen/case are ignored on verify.
const formatBackupCode = (raw) => `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
const normalizeBackupCode = (code) => String(code || '').replace(/[\s-]/g, '').toLowerCase();

// Returns { plain: string[], hashed: [{ codeHash }] }. Plaintext is shown to the
// user once and never persisted.
export const generateBackupCodes = (count = BACKUP_CODE_COUNT) => {
  const plain = [];
  const hashed = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex'); // 10 hex chars
    const code = formatBackupCode(raw);
    plain.push(code);
    hashed.push({ codeHash: tokenHash(normalizeBackupCode(code)), usedAt: null });
  }
  return { plain, hashed };
};

// Finds the matching unused backup code and marks it used in place. Returns true
// on a hit. Caller is responsible for saving the mutated array.
export const consumeBackupCode = (backupCodes, code) => {
  const target = tokenHash(normalizeBackupCode(code));
  const entry = (backupCodes || []).find((c) => c.codeHash === target && !c.usedAt);
  if (!entry) return false;
  entry.usedAt = new Date();
  return true;
};

export const countUnusedBackupCodes = (backupCodes) =>
  (backupCodes || []).filter((c) => !c.usedAt).length;
