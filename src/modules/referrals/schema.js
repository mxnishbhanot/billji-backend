import { body, query } from 'express-validator';
import { MAX_CODE_LENGTH, MIN_CODE_LENGTH, isReferralCodeShape, normalizeReferralCode } from '../../utils/referralCode.js';

// Shape only. Whether a code exists, whether the caller may use it and whether they are still
// eligible are all service decisions — a validator that answered them would be a second, divergent
// copy of the rules.

const codeRule = (field) =>
  body(field)
    .customSanitizer(normalizeReferralCode)
    .isLength({ min: MIN_CODE_LENGTH, max: MAX_CODE_LENGTH })
    .withMessage(`Referral code must be ${MIN_CODE_LENGTH}-${MAX_CODE_LENGTH} characters`)
    .custom(isReferralCodeShape)
    .withMessage('That referral code contains characters we do not use');

export const applyReferralRules = [codeRule('code')];

export const validateCodeRules = [codeRule('code')];

// Optional on the signup paths: no code is the normal case, and a malformed one must not fail a
// registration — the service treats it as "not applied" and says why.
export const signupReferralRule = body('referralCode')
  .optional({ nullable: true, checkFalsy: true })
  .customSanitizer(normalizeReferralCode)
  .isLength({ min: MIN_CODE_LENGTH, max: MAX_CODE_LENGTH })
  .withMessage(`Referral code must be ${MIN_CODE_LENGTH}-${MAX_CODE_LENGTH} characters`);

export const listRules = [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 })
];
