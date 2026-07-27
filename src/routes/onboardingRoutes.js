import { Router } from 'express';
import { body } from 'express-validator';
import {
  getOnboardingProgress,
  patchOnboardingProgress,
  replayOnboarding
} from '../controllers/onboardingController.js';
import { protect } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);

router.get('/progress', getOnboardingProgress);

router.patch(
  '/progress',
  [
    body('orientation').optional().isObject(),
    body('tips').optional().isObject()
  ],
  validate,
  patchOnboardingProgress
);

router.post(
  '/replay',
  [
    body('orientation').optional().isBoolean(),
    body('tipIds').optional().isArray(),
    body('tipIds.*').optional().isString().isLength({ max: 80 })
  ],
  validate,
  replayOnboarding
);

export default router;
