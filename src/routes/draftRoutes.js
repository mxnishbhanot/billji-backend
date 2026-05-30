import { Router } from 'express';
import {
  deleteDraft,
  draftIdRules,
  draftQueryRules,
  draftRules,
  listDrafts,
  upsertDraft
} from '../controllers/draftController.js';
import { protect } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);
router.get('/', draftQueryRules, validate, listDrafts);
router.put('/:localDraftId', draftIdRules, draftRules, validate, upsertDraft);
router.delete('/:localDraftId', draftIdRules, validate, deleteDraft);

export default router;
