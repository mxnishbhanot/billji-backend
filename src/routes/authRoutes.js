import { Router } from 'express';
import {
  confirmPasswordReset,
  googleRules,
  googleSignIn,
  login,
  loginRules,
  logout,
  me,
  register,
  registerRules,
  refreshRules,
  refreshSession,
  requestPasswordReset,
  resetConfirmRules,
  resetRequestRules,
  revokeSession,
  sessionIdRules,
  listSessions,
  settingsRules,
  updateSettings
} from '../controllers/authController.js';
import {
  disable as twoFactorDisable,
  emailEnable,
  emailEnableRules,
  emailSetup,
  getStatus as twoFactorStatus,
  manageRules,
  regenerateBackupCodes,
  resendLoginCode,
  resendRules,
  sendManageCode,
  totpEnable,
  totpEnableRules,
  totpSetup,
  verify as twoFactorVerify,
  verifyRules
} from '../controllers/twoFactorController.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { authLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.post('/register', authLimiter, registerRules, validate, register);
router.post('/login', authLimiter, loginRules, validate, login);
router.post('/google', authLimiter, googleRules, validate, googleSignIn);
router.post('/refresh', refreshRules, validate, refreshSession);
router.post('/logout', protect, logout);
router.get('/sessions', protect, listSessions);
router.delete('/sessions/:sessionId', protect, sessionIdRules, validate, revokeSession);
router.post('/password-reset/request', authLimiter, resetRequestRules, validate, requestPasswordReset);
router.post('/password-reset/confirm', authLimiter, resetConfirmRules, validate, confirmPasswordReset);
// --- Two-factor authentication ---
// Login second step (no session yet — authorized by the challenge token in body).
router.post('/2fa/verify', authLimiter, verifyRules, validate, twoFactorVerify);
router.post('/2fa/resend', authLimiter, resendRules, validate, resendLoginCode);
// Enrollment / management (require an authenticated session).
router.get('/2fa/status', protect, twoFactorStatus);
router.post('/2fa/totp/setup', protect, authLimiter, totpSetup);
router.post('/2fa/totp/enable', protect, authLimiter, totpEnableRules, validate, totpEnable);
router.post('/2fa/email/setup', protect, authLimiter, emailSetup);
router.post('/2fa/email/enable', protect, authLimiter, emailEnableRules, validate, emailEnable);
router.post('/2fa/send-code', protect, authLimiter, sendManageCode);
router.post('/2fa/disable', protect, authLimiter, manageRules, validate, twoFactorDisable);
router.post('/2fa/backup-codes/regenerate', protect, authLimiter, manageRules, validate, regenerateBackupCodes);

router.get('/me', protect, me);
router.patch('/settings', protect, requirePermission(PERMISSIONS.settingsManage), settingsRules, validate, updateSettings);

export default router;
