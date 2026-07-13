import { Router } from 'express';
import {
  acceptInvitation,
  acceptRules,
  cancelInvitation,
  inviteMember,
  inviteRules,
  invitationIdRules,
  listInvitations,
  listMembers,
  removeMember,
  resendInvitation,
  roleUpdateRules,
  statusUpdateRules,
  updateMemberRole,
  updateMemberStatus,
  userIdRules
} from '../controllers/teamController.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

// Public: an invitee (possibly without an account yet) accepts via the emailed token.
router.post('/invitations/accept', acceptRules, validate, acceptInvitation);

router.use(protect);

router.get('/members', requirePermission(PERMISSIONS.teamView), listMembers);
router.patch('/members/:userId/role', requirePermission(PERMISSIONS.teamManage), roleUpdateRules, validate, updateMemberRole);
router.patch('/members/:userId/status', requirePermission(PERMISSIONS.teamManage), statusUpdateRules, validate, updateMemberStatus);
router.delete('/members/:userId', requirePermission(PERMISSIONS.teamManage), userIdRules, validate, removeMember);

router.get('/invitations', requirePermission(PERMISSIONS.teamView), listInvitations);
router.post('/invitations', requirePermission(PERMISSIONS.teamManage), inviteRules, validate, inviteMember);
router.post('/invitations/:id/resend', requirePermission(PERMISSIONS.teamManage), invitationIdRules, validate, resendInvitation);
router.delete('/invitations/:id', requirePermission(PERMISSIONS.teamManage), invitationIdRules, validate, cancelInvitation);

export default router;
