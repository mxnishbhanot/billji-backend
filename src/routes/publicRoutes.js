import { Router } from 'express';
import { publicInvoicePdf } from '../controllers/invoiceController.js';
import { publicExportDownload } from '../modules/exports/controller.js';

const router = Router();

router.get('/invoices/:id/:token/pdf', publicInvoicePdf);
// Emailed download link. The token is the credential — see resolveDownloadByToken.
router.get('/exports/:id/:token', publicExportDownload);

export default router;
