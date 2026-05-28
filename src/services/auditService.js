import AuditLog from '../models/AuditLog.js';

const requestIp = (req) => req?.ip || req?.headers?.['x-forwarded-for']?.split(',')?.[0]?.trim() || '';

export const logAudit = (req, { action, resourceType = '', resourceId = null, metadata = {} }) =>
  AuditLog.create({
    business: req?.business?._id || null,
    user: req?.user?._id || null,
    session: req?.session?._id || null,
    action,
    resourceType,
    resourceId,
    ipAddress: requestIp(req),
    userAgent: req?.get?.('user-agent') || '',
    metadata
  }).catch(() => {});
