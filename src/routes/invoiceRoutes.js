import { Router } from 'express';
import {
  createInvoice,
  deleteInvoice,
  downloadInvoicePdf,
  duplicateInvoice,
  emailInvoice,
  getInvoice,
  invoiceQueryRules,
  invoiceRules,
  listInvoices,
  updateInvoiceStatus,
  whatsappInvoice
} from '../controllers/invoiceController.js';
import { protect } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', invoiceQueryRules, validate, listInvoices);
router.post('/', invoiceRules, validate, createInvoice);
router.get('/:id', getInvoice);
router.patch('/:id/status', updateInvoiceStatus);
router.post('/:id/duplicate', duplicateInvoice);
router.delete('/:id', deleteInvoice);
router.get('/:id/pdf', downloadInvoicePdf);
router.get('/:id/whatsapp', whatsappInvoice);
router.post('/:id/email', emailInvoice);

export default router;
