import { body, query } from 'express-validator';
import { ORDER_STATUSES } from '../../models/Order.js';

export const ORDER_SORT_OPTIONS = {
  newest: { date: -1, createdAt: -1 },
  oldest: { date: 1, createdAt: 1 },
  'amount-high': { total: -1, date: -1 },
  'amount-low': { total: 1, date: -1 }
};

export const orderRules = [
  body('customerId').optional({ nullable: true }).isMongoId(),
  body('customer.name').if(body('customerId').not().exists()).trim().notEmpty(),
  body('customer.phone').if(body('customerId').not().exists()).trim().notEmpty(),
  body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
  body('items.*.productId').optional({ nullable: true }).isMongoId(),
  body('items.*.name').optional().trim().isLength({ max: 120 }),
  body('items.*.quantity').isInt({ min: 1 }),
  body('items.*.price').optional().isFloat({ min: 0 }),
  body('taxRate').optional().isFloat({ min: 0, max: 100 }),
  body('discountType').optional().isIn(['flat', 'percentage']),
  body('discountValue').optional().isFloat({ min: 0 }),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 })
];

export const orderQueryRules = [
  query('search').optional({ checkFalsy: true }).trim().isLength({ max: 80 }),
  query('orderStatus').optional({ checkFalsy: true }).isIn(ORDER_STATUSES).withMessage('Invalid order status'),
  query('customerId').optional({ checkFalsy: true }).isMongoId().withMessage('Invalid customerId'),
  query('sort').optional({ checkFalsy: true }).isIn(Object.keys(ORDER_SORT_OPTIONS)).withMessage('Invalid sort option'),
  query('page').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Page must be 1 or greater'),
  query('limit').optional({ checkFalsy: true }).isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
];
