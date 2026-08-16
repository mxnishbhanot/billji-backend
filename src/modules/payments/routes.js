import { Router } from 'express';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { validate } from '../../middlewares/validate.js';
import {
  applyCredit,
  listBusinessPayments,
  listCustomerCredits,
  listCustomerOutstanding,
  markInvoiceRefundProcessed,
  recordCustomerPayment,
  recordInvoicePayment,
  reverseCreditApplication
} from './controller.js';
import {
  allocationParamRules,
  applyCreditRules,
  customerPaymentParamRules,
  invoicePaymentParamRules,
  paymentQueryRules,
  recordCustomerPaymentRules,
  recordPaymentRules,
  reverseAllocationRules
} from './schema.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.paymentsView), paymentQueryRules, validate, listBusinessPayments);
router.get('/customers/:customerId/outstanding', requirePermission(PERMISSIONS.paymentsView), customerPaymentParamRules, validate, listCustomerOutstanding);
router.post('/invoices/:invoiceId/record', requirePermission(PERMISSIONS.paymentsRecord), invoicePaymentParamRules, recordPaymentRules, validate, idempotency(), recordInvoicePayment);
router.post('/customers/:customerId/record', requirePermission(PERMISSIONS.paymentsRecord), customerPaymentParamRules, recordCustomerPaymentRules, validate, idempotency(), recordCustomerPayment);
router.get('/customers/:customerId/credits', requirePermission(PERMISSIONS.paymentsView), customerPaymentParamRules, validate, listCustomerCredits);
// idempotency() defends against client retries; the compare-and-set inside the workflow
// defends against genuine concurrency. Both are needed — different problems.
router.post('/invoices/:invoiceId/apply-credit', requirePermission(PERMISSIONS.paymentsRecord), invoicePaymentParamRules, applyCreditRules, validate, idempotency(), applyCredit);
router.post('/allocations/:allocationId/reverse', requirePermission(PERMISSIONS.paymentsRecord), allocationParamRules, reverseAllocationRules, validate, idempotency(), reverseCreditApplication);
router.post('/invoices/:invoiceId/refund-processed', requirePermission(PERMISSIONS.paymentsRecord), invoicePaymentParamRules, validate, idempotency(), markInvoiceRefundProcessed);

export default router;
