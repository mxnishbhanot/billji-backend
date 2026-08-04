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
import { FEATURES } from '../constants/entitlements.js';
import { protect } from '../middlewares/auth.js';
import { PERMISSIONS, requirePermission } from '../middlewares/authorization.js';
import { requireFeature } from '../middlewares/entitlement.js';
import { validate } from '../middlewares/validate.js';

const router = Router();

// Public: an invitee (possibly without an account yet) accepts via the emailed token.
router.post('/invitations/accept', acceptRules, validate, acceptInvitation);

router.use(protect);

// Reads and *shrinking* the team are never gated: a business that downgrades must still be able
// to see who has access and take it away. Only growing the team is the paid feature — the seat
// ceiling itself is enforced inside inviteMember via teamLimitService.
const teamsFeature = requireFeature(FEATURES.teams);

router.get('/members', requirePermission(PERMISSIONS.teamView), listMembers);
router.patch('/members/:userId/role', requirePermission(PERMISSIONS.teamManage), teamsFeature, roleUpdateRules, validate, updateMemberRole);
router.patch('/members/:userId/status', requirePermission(PERMISSIONS.teamManage), teamsFeature, statusUpdateRules, validate, updateMemberStatus);
router.delete('/members/:userId', requirePermission(PERMISSIONS.teamManage), userIdRules, validate, removeMember);

router.get('/invitations', requirePermission(PERMISSIONS.teamView), listInvitations);
router.post('/invitations', requirePermission(PERMISSIONS.teamManage), teamsFeature, inviteRules, validate, inviteMember);
router.post('/invitations/:id/resend', requirePermission(PERMISSIONS.teamManage), teamsFeature, invitationIdRules, validate, resendInvitation);
router.delete('/invitations/:id', requirePermission(PERMISSIONS.teamManage), invitationIdRules, validate, cancelInvitation);

export default router;
