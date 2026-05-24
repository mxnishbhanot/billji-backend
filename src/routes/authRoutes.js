import { Router } from 'express';
import {
  login,
  loginRules,
  me,
  register,
  registerRules,
  settingsRules,
  updateSettings
} from '../controllers/authController.js';
import { protect } from '../middlewares/auth.js';
import { authLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.post('/register', authLimiter, registerRules, validate, register);
router.post('/login', authLimiter, loginRules, validate, login);
router.get('/me', protect, me);
router.patch('/settings', protect, settingsRules, validate, updateSettings);

export default router;
