import { Router } from 'express';
import {
  confirmPasswordReset,
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
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { authLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.post('/register', authLimiter, registerRules, validate, register);
router.post('/login', authLimiter, loginRules, validate, login);
router.post('/refresh', refreshRules, validate, refreshSession);
router.post('/logout', protect, logout);
router.get('/sessions', protect, listSessions);
router.delete('/sessions/:sessionId', protect, sessionIdRules, validate, revokeSession);
router.post('/password-reset/request', authLimiter, resetRequestRules, validate, requestPasswordReset);
router.post('/password-reset/confirm', authLimiter, resetConfirmRules, validate, confirmPasswordReset);
router.get('/me', protect, me);
router.patch('/settings', protect, requirePermission(PERMISSIONS.settingsManage), settingsRules, validate, updateSettings);

export default router;
