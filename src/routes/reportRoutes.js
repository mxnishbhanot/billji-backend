import { Router } from 'express';
import { summary } from '../controllers/reportController.js';
import { protect } from '../middlewares/auth.js';

const router = Router();

router.use(protect);
router.get('/summary', summary);

export default router;
