import crypto from 'crypto';

/**
 * Referral codes: short, human-readable, permanent.
 *
 * The alphabet is Crockford-style — no I, O, 0, 1 or L — because these codes are read aloud, typed
 * from a screenshot and written on paper. A code that cannot be misread is worth more here than two
 * extra bits of entropy.
 *
 * 8 characters over a 32-symbol alphabet is ~40 bits. Guessing is not a threat model worth more than
 * that: the only thing a valid code does is name a referrer, and /referrals/validate is rate-limited
 * like every other unauthenticated route.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

export const MIN_CODE_LENGTH = 6;
export const MAX_CODE_LENGTH = 12;

export const generateReferralCode = () => {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return code;
};

/**
 * What a stored/compared code looks like. Applied to user input before every lookup so
 * "billji8x2a", " BILLJI8X2A " and "BILLJI8X2A" are the same code.
 */
export const normalizeReferralCode = (value) => String(value || '').trim().toUpperCase();

export const isReferralCodeShape = (value) => {
  const code = normalizeReferralCode(value);
  if (code.length < MIN_CODE_LENGTH || code.length > MAX_CODE_LENGTH) return false;
  return [...code].every((character) => ALPHABET.includes(character));
};
