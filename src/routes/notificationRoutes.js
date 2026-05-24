import { Router } from 'express';
import { body, query } from 'express-validator';
import { listNotifications, markNotificationsSeen } from '../controllers/notificationController.js';
import { protect } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get(
  '/',
  [
    query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Page must be 1 or greater'),
    query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
  ],
  validate,
  listNotifications
);
router.patch(
  '/seen',
  [body('notificationIds').optional().isArray(), body('notificationIds.*').optional().isString().isLength({ max: 180 })],
  validate,
  markNotificationsSeen
);

export default router;
