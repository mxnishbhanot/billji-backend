import { Router } from 'express';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { validate } from '../../middlewares/validate.js';
import { listBusinessPayments, listCustomerOutstanding, recordCustomerPayment, recordInvoicePayment } from './controller.js';
import {
  customerPaymentParamRules,
  invoicePaymentParamRules,
  paymentQueryRules,
  recordCustomerPaymentRules,
  recordPaymentRules
} from './schema.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.paymentsView), paymentQueryRules, validate, listBusinessPayments);
router.get('/customers/:customerId/outstanding', requirePermission(PERMISSIONS.paymentsView), customerPaymentParamRules, validate, listCustomerOutstanding);
router.post('/invoices/:invoiceId/record', requirePermission(PERMISSIONS.paymentsRecord), invoicePaymentParamRules, recordPaymentRules, validate, idempotency(), recordInvoicePayment);
router.post('/customers/:customerId/record', requirePermission(PERMISSIONS.paymentsRecord), customerPaymentParamRules, recordCustomerPaymentRules, validate, idempotency(), recordCustomerPayment);

export default router;
