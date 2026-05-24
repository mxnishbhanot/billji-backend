import { Router } from 'express';
import { getSettings, settingsRules, updateSettings } from '../controllers/settingsController.js';
import { protect } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', getSettings);
router.patch('/', settingsRules, validate, updateSettings);

export default router;
