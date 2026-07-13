import crypto from 'crypto';
import { body, param } from 'express-validator';
import Business from '../models/Business.js';
import BusinessInvitation from '../models/BusinessInvitation.js';
import BusinessMember from '../models/BusinessMember.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import { env, isProduction } from '../config/env.js';
import { permissionsForRoleKey } from '../middlewares/authorization.js';
import { logAudit } from '../services/auditService.js';
import { sendTeamInviteEmail } from '../services/emailService.js';
import { canInvite } from '../services/teamLimitService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { EMAIL_NORMALIZE } from '../utils/email.js';
import { tokenHash } from '../utils/jwt.js';
import { sessionResponse } from './authController.js';

const INVITE_TTL_DAYS = 7;
const ROLE_NAMES = { owner: 'Owner', admin: 'Admin', accountant: 'Accountant', staff: 'Staff', viewer: 'Viewer' };
const ASSIGNABLE_ROLE_KEYS = ['owner', 'admin', 'accountant', 'staff', 'viewer'];

// --- guards -----------------------------------------------------------------

// A member may only grant a role whose permission set is a subset of their own, and
// only an owner may grant the owner role. Prevents privilege escalation via invite/re-role.
const assertCanGrantRole = (req, targetRoleKey) => {
  if (targetRoleKey === 'owner' && req.membership.roleKey !== 'owner') {
    throw new ApiError(403, 'Only an owner can grant the owner role');
  }
  const actorPermissions = new Set(req.permissions || []);
  const targetPermissions = permissionsForRoleKey(targetRoleKey);
  const escalates = targetPermissions.some((permission) => !actorPermissions.has(permission));
  if (escalates) {
    throw new ApiError(403, 'You cannot grant a role with more permissions than your own');
  }
};

const countActiveOwners = (businessId) =>
  BusinessMember.countDocuments({ business: businessId, roleKey: 'owner', status: 'active' });

// Blocks any change that would leave a business with zero active owners.
const assertNotLastOwner = async (businessId, member) => {
  if (member.roleKey !== 'owner' || member.status !== 'active') return;
  if ((await countActiveOwners(businessId)) <= 1) {
    throw new ApiError(409, 'Cannot remove or change the last active owner');
  }
};

const generateInviteToken = () => crypto.randomBytes(24).toString('base64url');

// --- validation rules -------------------------------------------------------

export const inviteRules = [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(EMAIL_NORMALIZE),
  body('roleKey').optional().isIn(ASSIGNABLE_ROLE_KEYS).withMessage('Invalid role'),
  body('roleId').optional().isMongoId().withMessage('Valid role id is required'),
  body().custom((value) => {
    if (!value.roleKey && !value.roleId) throw new Error('Provide roleKey or roleId');
    if (value.roleKey && value.roleId) throw new Error('Provide only one of roleKey or roleId');
    return true;
  })
];

export const acceptRules = [
  body('token').isString().trim().notEmpty().withMessage('Invitation token is required'),
  body('name').optional().trim().isLength({ max: 80 }),
  body('password').optional().isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
];

export const roleUpdateRules = [
  param('userId').isMongoId().withMessage('Valid user id is required'),
  body('roleKey').optional().isIn(ASSIGNABLE_ROLE_KEYS).withMessage('Invalid role'),
  body('roleId').optional().isMongoId().withMessage('Valid role id is required'),
  body().custom((value) => {
    if (!value.roleKey && !value.roleId) throw new Error('Provide roleKey or roleId');
    if (value.roleKey && value.roleId) throw new Error('Provide only one of roleKey or roleId');
    return true;
  })
];

export const statusUpdateRules = [
  param('userId').isMongoId().withMessage('Valid user id is required'),
  body('status').isIn(['active', 'archived']).withMessage('Status must be active or archived')
];

export const userIdRules = [param('userId').isMongoId().withMessage('Valid user id is required')];
export const invitationIdRules = [param('id').isMongoId().withMessage('Valid invitation id is required')];

// --- members ----------------------------------------------------------------

export const listMembers = asyncHandler(async (req, res) => {
  const members = await BusinessMember.find({ business: req.business._id, status: { $ne: 'removed' } })
    .populate('user', 'name email')
    .populate('role', 'name')
    .sort({ joinedAt: 1 });

  res.json({
    success: true,
    members: members.map((m) => ({
      userId: m.user?._id,
      name: m.user?.name,
      email: m.user?.email,
      roleKey: m.roleKey,
      roleName: m.role?.name || null,
      roleId: m.role?._id || null,
      status: m.status,
      joinedAt: m.joinedAt
    }))
  });
});

const findMember = async (req) => {
  const member = await BusinessMember.findOne({ business: req.business._id, user: req.params.userId });
  if (!member || member.status === 'removed') throw new ApiError(404, 'Team member not found');
  return member;
};

export const updateMemberRole = asyncHandler(async (req, res) => {
  const member = await findMember(req);
  const from = { roleKey: member.roleKey, role: member.role };

  if (req.body.roleId) {
    // Custom role assignment. An owner must be demoted via a system role first so the
    // owner-count guard stays meaningful — no custom-role owners.
    if (member.roleKey === 'owner') {
      throw new ApiError(409, 'Change this owner to a system role before assigning a custom role');
    }
    const role = await Role.findOne({ _id: req.body.roleId, business: req.business._id, isSystem: false, isArchived: false })
      .populate('permissions', 'key');
    if (!role) throw new ApiError(404, 'Custom role not found');

    const actorPermissions = new Set(req.permissions || []);
    const escalates = role.permissions.some((p) => !actorPermissions.has(p.key));
    if (escalates) throw new ApiError(403, 'You cannot assign a role with more permissions than your own');

    member.role = role._id;
    await member.save();
    void logAudit(req, { action: 'member.role_changed', resourceType: 'member', resourceId: member.user, metadata: { from, to: { roleId: role._id, key: role.key } } });
    return res.json({ success: true });
  }

  const roleKey = req.body.roleKey;
  assertCanGrantRole(req, roleKey);
  // Demoting an owner away from owner reduces the owner count.
  if (member.roleKey === 'owner' && roleKey !== 'owner') await assertNotLastOwner(req.business._id, member);

  member.roleKey = roleKey;
  member.role = null; // clears any custom role; system-role permissions now apply
  await member.save();
  void logAudit(req, { action: 'member.role_changed', resourceType: 'member', resourceId: member.user, metadata: { from, to: { roleKey } } });

  res.json({ success: true });
});

export const updateMemberStatus = asyncHandler(async (req, res) => {
  const member = await findMember(req);
  const { status } = req.body;
  if (status === 'archived') await assertNotLastOwner(req.business._id, member);

  member.status = status;
  if (status === 'archived') {
    member.archivedAt = new Date();
    member.archivedBy = req.user._id;
  } else {
    member.archivedAt = null;
    member.archivedBy = null;
  }
  await member.save();
  void logAudit(req, {
    action: status === 'archived' ? 'member.archived' : 'member.restored',
    resourceType: 'member',
    resourceId: member.user
  });

  res.json({ success: true });
});

export const removeMember = asyncHandler(async (req, res) => {
  const member = await findMember(req);
  await assertNotLastOwner(req.business._id, member);

  member.status = 'removed';
  member.removedAt = new Date();
  member.removedBy = req.user._id;
  await member.save();
  void logAudit(req, { action: 'member.removed', resourceType: 'member', resourceId: member.user });

  res.json({ success: true });
});

// --- invitations ------------------------------------------------------------

export const listInvitations = asyncHandler(async (req, res) => {
  const invitations = await BusinessInvitation.find({ business: req.business._id, status: 'pending' }).sort({ createdAt: -1 });
  res.json({
    success: true,
    invitations: invitations.map((i) => ({
      id: i._id,
      email: i.email,
      roleKey: i.roleKey,
      roleName: i.roleName,
      status: i.status,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt
    }))
  });
});

// Resolve the invited role from the body: a system roleKey or a custom roleId. For a
// custom role we store the role ref + a name snapshot and set roleKey to the safe base
// 'viewer' (the invitation enum is system-only; the custom role drives real permissions
// on accept). Both paths enforce no-escalation against the inviter's own permissions.
const resolveInviteAssignment = async (req) => {
  if (req.body.roleId) {
    const role = await Role.findOne({ _id: req.body.roleId, business: req.business._id, isSystem: false, isArchived: false }).populate('permissions', 'key');
    if (!role) throw new ApiError(404, 'Custom role not found');
    const actorPermissions = new Set(req.permissions || []);
    if (role.permissions.some((p) => !actorPermissions.has(p.key))) {
      throw new ApiError(403, 'You cannot assign a role with more permissions than your own');
    }
    return { roleKey: 'viewer', role: role._id, roleName: role.name };
  }
  const roleKey = req.body.roleKey;
  assertCanGrantRole(req, roleKey);
  return { roleKey, role: null, roleName: ROLE_NAMES[roleKey] };
};

const issueInvite = async (req, { email, roleKey, role = null, roleName }) => {
  const token = generateInviteToken();
  const invitation = await BusinessInvitation.create({
    business: req.business._id,
    email,
    roleKey,
    role,
    roleName,
    tokenHash: tokenHash(token),
    invitedBy: req.user._id,
    expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)
  });

  let emailError = null;
  try {
    await sendTeamInviteEmail({
      to: email,
      businessName: req.business.businessName,
      inviterName: req.user.name,
      roleName,
      token,
      appUrl: env.appDownloadUrl,
      ttlDays: INVITE_TTL_DAYS
    });
  } catch (err) {
    console.error('[team-invite] failed to send invite email:', err?.message || err);
    emailError = err?.message || String(err);
  }

  return { invitation, token, emailError };
};

export const inviteMember = asyncHandler(async (req, res) => {
  const email = req.body.email;
  const assignment = await resolveInviteAssignment(req);

  // Already an active member?
  const existingUser = await User.findOne({ email }).select('_id');
  if (existingUser) {
    const existingMember = await BusinessMember.findOne({ business: req.business._id, user: existingUser._id, status: 'active' });
    if (existingMember) throw new ApiError(409, 'This person is already a team member');
  }

  // One live invite per email per business.
  const pending = await BusinessInvitation.findOne({ business: req.business._id, email, status: 'pending' });
  if (pending) throw new ApiError(409, 'An invitation for this email is already pending');

  const { allowed, limit } = await canInvite(req.business);
  if (!allowed) {
    throw new ApiError(403, `Your plan allows up to ${limit} team members. Upgrade to add more.`, { code: 'MEMBER_LIMIT_REACHED' });
  }

  const { invitation, token, emailError } = await issueInvite(req, { email, ...assignment });
  void logAudit(req, { action: 'invitation.sent', resourceType: 'invitation', resourceId: invitation._id, metadata: { email, roleKey: assignment.roleKey, role: assignment.role } });

  res.status(201).json({
    success: true,
    invitation: { id: invitation._id, email, roleKey: invitation.roleKey, roleName: invitation.roleName, expiresAt: invitation.expiresAt },
    inviteToken: !isProduction ? token : undefined,
    emailError: !isProduction ? emailError : undefined
  });
});

export const resendInvitation = asyncHandler(async (req, res) => {
  const invitation = await BusinessInvitation.findOne({ _id: req.params.id, business: req.business._id, status: 'pending' });
  if (!invitation) throw new ApiError(404, 'Pending invitation not found');

  // Rotate the token so an old leaked link stops working.
  const token = generateInviteToken();
  invitation.tokenHash = tokenHash(token);
  invitation.expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await invitation.save();

  let emailError = null;
  try {
    await sendTeamInviteEmail({
      to: invitation.email,
      businessName: req.business.businessName,
      inviterName: req.user.name,
      roleName: invitation.roleName,
      token,
      appUrl: env.appDownloadUrl,
      ttlDays: INVITE_TTL_DAYS
    });
  } catch (err) {
    emailError = err?.message || String(err);
  }
  void logAudit(req, { action: 'invitation.resent', resourceType: 'invitation', resourceId: invitation._id });

  res.json({ success: true, inviteToken: !isProduction ? token : undefined, emailError: !isProduction ? emailError : undefined });
});

export const cancelInvitation = asyncHandler(async (req, res) => {
  const invitation = await BusinessInvitation.findOne({ _id: req.params.id, business: req.business._id, status: 'pending' });
  if (!invitation) throw new ApiError(404, 'Pending invitation not found');

  invitation.status = 'cancelled';
  await invitation.save();
  void logAudit(req, { action: 'invitation.cancelled', resourceType: 'invitation', resourceId: invitation._id });

  res.json({ success: true });
});

// --- public accept ----------------------------------------------------------

// Public (no auth). The high-entropy token proves email control. For a NEW user we
// take name+password and issue a session (that password is their credential). For an
// EXISTING user we only add the membership and return joined:true — issuing a session
// on an email-only token would be an account-takeover bypass; they sign in normally.
export const acceptInvitation = asyncHandler(async (req, res) => {
  const invitation = await BusinessInvitation.findOne({ tokenHash: tokenHash(req.body.token), status: 'pending' });
  if (!invitation) throw new ApiError(422, 'Invitation is invalid or already used');
  if (invitation.expiresAt <= new Date()) {
    invitation.status = 'expired';
    await invitation.save();
    throw new ApiError(422, 'Invitation has expired');
  }

  const business = await Business.findOne({ _id: invitation.business, status: 'active' });
  if (!business) throw new ApiError(410, 'The inviting business is no longer active');

  let user = await User.findOne({ email: invitation.email });
  const isNewUser = !user;

  if (isNewUser) {
    if (!req.body.name || !req.body.password) {
      throw new ApiError(422, 'Name and password are required to create your account', { code: 'ACCOUNT_SETUP_REQUIRED' });
    }
    user = await User.create({ name: req.body.name, email: invitation.email, password: req.body.password });
  }

  // Upsert membership to active with the invitation's role snapshot.
  const member = await BusinessMember.findOne({ business: business._id, user: user._id });
  if (member && member.status === 'active') {
    invitation.status = 'accepted';
    invitation.acceptedAt = new Date();
    await invitation.save();
    throw new ApiError(409, 'You are already a member of this business');
  }
  if (member) {
    member.roleKey = invitation.roleKey;
    member.role = invitation.role;
    member.status = 'active';
    member.joinedAt = new Date();
    member.removedAt = null;
    member.removedBy = null;
    member.archivedAt = null;
    member.archivedBy = null;
    await member.save();
  } else {
    await BusinessMember.create({
      business: business._id,
      user: user._id,
      roleKey: invitation.roleKey,
      role: invitation.role,
      status: 'active',
      invitedBy: invitation.invitedBy,
      joinedAt: new Date()
    });
  }

  if (!user.defaultBusiness) {
    user.defaultBusiness = business._id;
    await user.save();
  }

  invitation.status = 'accepted';
  invitation.acceptedAt = new Date();
  await invitation.save();

  const auditReq = { ...req, business, user };
  void logAudit(auditReq, { action: 'invitation.accepted', resourceType: 'member', resourceId: user._id, metadata: { roleKey: invitation.roleKey } });

  if (isNewUser) {
    const session = await sessionResponse({ req, user, business });
    return res.status(201).json({ ...session, joined: true });
  }
  return res.json({ success: true, joined: true, message: 'Invitation accepted. Please sign in to access this business.' });
});
