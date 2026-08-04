import { Router } from 'express';
import { publicInvoicePdf } from '../controllers/invoiceController.js';
import { publicExportDownload } from '../modules/exports/controller.js';
import { validateReferralCode } from '../modules/referrals/controller.js';
import { validateCodeRules } from '../modules/referrals/schema.js';
import { authLimiter } from '../middlewares/rateLimit.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.get('/invoices/:id/:token/pdf', publicInvoicePdf);
// Emailed download link. The token is the credential — see resolveDownloadByToken.
router.get('/exports/:id/:token', publicExportDownload);
// Checked before an account exists, so it cannot sit behind `protect`. Rate-limited like the other
// unauthenticated routes, and it answers with a display name only — never enough to enumerate accounts.
router.post('/referrals/validate', authLimiter, validateCodeRules, validate, validateReferralCode);

export default router;
