import { Router } from 'express';
import { protect } from '../../middlewares/auth.js';
import { syncLimiter } from '../../middlewares/rateLimit.js';
import { validate } from '../../middlewares/validate.js';
import { bootstrap, enforceBatchSize, pullChanges, pushChanges, registerSyncDevice, syncStatus } from './controller.js';
import { requireSyncProtocol } from './protocol.js';
import { bootstrapRules, deviceRules, pullRules, pushRules } from './schema.js';

const router = Router();

// Per-collection permissions vary by request, so authorization happens in the controller
// rather than as a fixed requirePermission on the route.
router.use(syncLimiter, protect, requireSyncProtocol);

router.get('/status', syncStatus);
router.get('/pull', pullRules, validate, pullChanges);
router.get('/bootstrap', bootstrapRules, validate, bootstrap);
router.post('/device', deviceRules, validate, registerSyncDevice);
router.post('/push', enforceBatchSize, pushRules, validate, pushChanges);

export default router;
