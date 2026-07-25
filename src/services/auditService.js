import AuditLog from '../models/AuditLog.js';

const requestIp = (req) => req?.ip || req?.headers?.['x-forwarded-for']?.split(',')?.[0]?.trim() || '';

// `business` is normally taken from the authenticated request. Public/tokenised routes
// have no req.business, so they pass it explicitly to keep the entry in the right
// business's activity log.
export const logAudit = (req, { action, resourceType = '', resourceId = null, metadata = {}, business = null }) =>
  AuditLog.create({
    business: business || req?.business?._id || null,
    user: req?.user?._id || null,
    session: req?.session?._id || null,
    action,
    resourceType,
    resourceId,
    ipAddress: requestIp(req),
    userAgent: req?.get?.('user-agent') || '',
    metadata
  }).catch(() => {});
