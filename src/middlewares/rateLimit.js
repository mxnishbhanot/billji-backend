import rateLimit from 'express-rate-limit';

const rateLimitKey = (req) =>
  [req.ip, req.user?._id?.toString(), req.business?._id?.toString()]
    .filter(Boolean)
    .join(':');

// Rate limits would make the test suite flaky (it fires many auth calls from a
// single IP in quick succession), so disable them under NODE_ENV=test only.
// Read process.env live — the test harness sets NODE_ENV after this module loads.
const skipInTest = () => process.env.NODE_ENV === 'test';

// Sync gets its own bucket. Draining a 500-operation outbox after a two-day outage is
// legitimate traffic that looks like an attack to a limiter tuned for human tapping, so
// the general limiter steps aside on these paths instead of stacking on top.
const isSyncPath = (req) => req.path.includes('/sync/');

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  keyGenerator: rateLimitKey,
  skip: (req, res) => skipInTest(req, res) || isSyncPath(req),
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: rateLimitKey,
  skip: skipInTest,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again later.'
  }
});

export const syncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 900,
  keyGenerator: rateLimitKey,
  skip: skipInTest,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Sync rate limit reached. Retry after the window resets.',
    details: { code: 'SYNC_RATE_LIMITED' }
  }
});
