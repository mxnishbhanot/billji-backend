import { Router } from 'express';
import { createBusiness, createBusinessRules } from '../controllers/businessController.js';
import { protect } from '../middlewares/auth.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

router.use(protect);

// No requirePermission by design — creating your own workspace is not an action inside the current
// one, so the caller's role there does not apply. See the controller for why.
//
// Deliberately NOT wrapped in idempotency(): that middleware scopes keys to req.business, and this
// route switches the caller into the workspace it just created — so the retry arrives under a
// different scope and would never match. The controller de-duplicates on the owner + name instead,
// which needs no header and covers the case that actually happens (a double tap resends the name).
router.post('/', createBusinessRules, validate, createBusiness);

export default router;
