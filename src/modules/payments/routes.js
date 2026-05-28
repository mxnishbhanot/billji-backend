import { Router } from 'express';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { validate } from '../../middlewares/validate.js';
import { listBusinessPayments, recordInvoicePayment } from './controller.js';
import { invoicePaymentParamRules, paymentQueryRules, recordPaymentRules } from './schema.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.paymentsView), paymentQueryRules, validate, listBusinessPayments);
router.post('/invoices/:invoiceId/record', requirePermission(PERMISSIONS.paymentsRecord), invoicePaymentParamRules, recordPaymentRules, validate, idempotency(), recordInvoicePayment);

export default router;
