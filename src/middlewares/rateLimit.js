import rateLimit from 'express-rate-limit';

const rateLimitKey = (req) =>
  [req.ip, req.user?._id?.toString(), req.business?._id?.toString()]
    .filter(Boolean)
    .join(':');

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  keyGenerator: rateLimitKey,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: rateLimitKey,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again later.'
  }
});
