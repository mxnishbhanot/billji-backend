import { Router } from 'express';
import { publicInvoicePdf } from '../controllers/invoiceController.js';
import { publicExportDownload } from '../modules/exports/controller.js';
import { validateReferralCode, validateReferralRules } from '../modules/referrals/controller.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.get('/invoices/:id/:token/pdf', publicInvoicePdf);
// Emailed download link. The token is the credential — see resolveDownloadByToken.
router.get('/exports/:id/:token', publicExportDownload);

// Unauthenticated on purpose: the signup form checks a code before an account exists. It answers
// only valid/invalid plus the referrer's business name, so it cannot be used to enumerate accounts.
router.post('/referrals/validate', validateReferralRules, validate, validateReferralCode);

export default router;
