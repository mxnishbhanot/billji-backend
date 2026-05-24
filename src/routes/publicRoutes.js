import { Router } from 'express';
import { publicInvoicePdf } from '../controllers/invoiceController.js';

const router = Router();

router.get('/invoices/:id/:token/pdf', publicInvoicePdf);

export default router;
