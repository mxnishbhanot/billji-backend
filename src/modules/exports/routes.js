import { Router } from 'express';
import { createExport, getExport, getExportDownloadUrl, getExports } from './controller.js';
import { protect } from '../../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../../middlewares/authorization.js';

const router = Router();

// An export is the entire business record in one file, so every route here — including
// the read-only ones — sits behind settings.export (owner/admin by default).
router.use(protect);
router.use(requirePermission(PERMISSIONS.settingsExport));

router.get('/', getExports);
router.post('/', createExport);
router.get('/:id', getExport);
// Hands back the presigned URL as JSON rather than redirecting: the app downloads the
// archive with no Authorization header, which a presigned S3/R2 GET requires.
router.get('/:id/download-url', getExportDownloadUrl);

export default router;
