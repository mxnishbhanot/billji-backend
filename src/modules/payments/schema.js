import { body, param, query } from 'express-validator';
import { PAYMENT_METHODS, PAYMENT_TYPES } from '../../models/Payment.js';

export const paymentQueryRules = [
  query('invoiceId').optional({ checkFalsy: true }).isMongoId(),
  query('customerId').optional({ checkFalsy: true }).isMongoId()
];

export const invoicePaymentParamRules = [
  param('invoiceId').isMongoId().withMessage('Valid invoice id is required')
];

export const customerPaymentParamRules = [
  param('customerId').isMongoId().withMessage('Valid customer id is required')
];

export const allocationParamRules = [
  param('allocationId').isMongoId().withMessage('Valid allocation id is required')
];

export const applyCreditRules = [
  body('amount').isFloat({ min: 0.01 }).withMessage('Credit amount must be greater than zero').toFloat()
];

export const reverseAllocationRules = [
  body('reason').optional({ nullable: true }).trim().isLength({ max: 200 })
];

export const recordCustomerPaymentRules = [
  body('amount').isFloat({ min: 0.01 }).withMessage('Payment amount must be greater than zero').toFloat(),
  body('invoiceIds').isArray({ min: 1 }).withMessage('At least one invoice is required'),
  body('invoiceIds.*').isMongoId().withMessage('Invalid invoice id'),
  body('allowCredit').optional().isBoolean().toBoolean(),
  body('method').optional().isIn(PAYMENT_METHODS),
  body('type').optional().isIn(PAYMENT_TYPES),
  body('currency').optional().trim().isLength({ min: 3, max: 3 }),
  body('reference').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 }),
  body('receivedAt').optional({ checkFalsy: true }).isISO8601(),
  body('metadata').optional().isObject()
];

export const recordPaymentRules = [
  body('amount').isFloat({ min: 0.01 }).withMessage('Payment amount must be greater than zero').toFloat(),
  body('method').optional().isIn(PAYMENT_METHODS),
  body('type').optional().isIn(PAYMENT_TYPES),
  body('currency').optional().trim().isLength({ min: 3, max: 3 }),
  body('reference').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 }),
  body('receivedAt').optional({ checkFalsy: true }).isISO8601(),
  body('provider.provider').optional({ nullable: true }).trim().isLength({ max: 80 }),
  body('provider.providerPaymentId').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('provider.providerOrderId').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('provider.providerSignature').optional({ nullable: true }).trim().isLength({ max: 500 }),
  body('provider.webhookEventId').optional({ nullable: true }).trim().isLength({ max: 160 }),
  body('metadata').optional().isObject()
];
