import { Router } from 'express';
import {
  cancelDocument,
  convertDocument,
  createDocument,
  documentQueryRules,
  documentRules,
  documentTypeRules,
  getDocument,
  listDocuments
} from './controller.js';
import { idempotency } from '../../middlewares/idempotency.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';
import { validate } from '../../middlewares/validate.js';

const router = Router();

// Quotations, challans and credit notes are all sales documents, so they reuse the invoice
// permissions rather than introducing a permission set nobody has been granted. Creating a
// credit note moves stock and money, so it sits behind invoicesCreate like an invoice does.
router.use(protect);

router.get('/:documentType', requirePermission(PERMISSIONS.invoicesView), documentQueryRules, validate, listDocuments);
router.post('/:documentType', requirePermission(PERMISSIONS.invoicesCreate), documentRules, validate, idempotency(), createDocument);
router.get('/:documentType/:id', requirePermission(PERMISSIONS.invoicesView), documentTypeRules, validate, getDocument);
router.post(
  '/:documentType/:id/convert',
  requirePermission(PERMISSIONS.invoicesCreate),
  documentTypeRules,
  validate,
  idempotency(),
  convertDocument
);
router.post('/:documentType/:id/cancel', requirePermission(PERMISSIONS.invoicesUpdate), documentTypeRules, validate, cancelDocument);

export default router;
