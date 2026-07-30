import { Router } from 'express';
import {
  createInvoice,
  deleteInvoice,
  downloadInvoicePdf,
  duplicateInvoice,
  emailInvoice,
  getInvoice,
  listInvoices,
  pendingReminders,
  prepareReminders,
  previewInvoice,
  reminderRules,
  revokeInvoiceShareLink,
  rotateInvoiceShareLink,
  updateInvoiceStatus,
  whatsappInvoice
} from './controller.js';
import { invoiceQueryRules, invoiceRules } from './schema.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', requirePermission(PERMISSIONS.invoicesView), invoiceQueryRules, validate, listInvoices);
router.post('/', requirePermission(PERMISSIONS.invoicesCreate), invoiceRules, validate, idempotency(), createInvoice);
router.post('/preview', requirePermission(PERMISSIONS.invoicesCreate), invoiceRules, validate, previewInvoice);
// Declared before '/:id' so 'reminders' is never read as an invoice id.
router.get('/reminders/pending', requirePermission(PERMISSIONS.invoicesView), pendingReminders);
router.post('/reminders/send', requirePermission(PERMISSIONS.invoicesView), reminderRules, validate, prepareReminders);
router.get('/:id', requirePermission(PERMISSIONS.invoicesView), getInvoice);
router.patch('/:id/status', requirePermission(PERMISSIONS.invoicesUpdate), updateInvoiceStatus);
router.post('/:id/duplicate', requirePermission(PERMISSIONS.invoicesCreate), idempotency(), duplicateInvoice);
router.delete('/:id', requirePermission(PERMISSIONS.invoicesDelete), idempotency(), deleteInvoice);
router.get('/:id/pdf', requirePermission(PERMISSIONS.invoicesView), downloadInvoicePdf);
router.get('/:id/whatsapp', requirePermission(PERMISSIONS.invoicesView), whatsappInvoice);
router.post('/:id/email', requirePermission(PERMISSIONS.invoicesView), emailInvoice);
router.post('/:id/share/rotate', requirePermission(PERMISSIONS.invoicesUpdate), rotateInvoiceShareLink);
router.post('/:id/share/revoke', requirePermission(PERMISSIONS.invoicesUpdate), revokeInvoiceShareLink);

export default router;
