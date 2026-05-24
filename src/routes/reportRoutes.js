import { Router } from 'express';
import { reportQueryRules, summary } from '../controllers/reportController.js';
import { protect } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/summary', reportQueryRules, validate, summary);

export default router;
