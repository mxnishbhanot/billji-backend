import dotenv from 'dotenv';

dotenv.config();

const parseOrigins = (value) =>
  value
    ? value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : [];

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGODB_URI || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || process.env.ACCESS_TOKEN_EXPIRES_IN || '15m',
  refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || 'dev-only-change-me-refresh',
  refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '30d',
  passwordResetTtlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES || 30),
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS || process.env.CLIENT_URL || 'http://localhost:5173'),
  apiPublicUrl: process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`,
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'QuickInvoice <no-reply@quickinvoice.local>'
  },
  // Resend (https://resend.com) is the active email provider. When apiKey is
  // unset, email sending is disabled and emailInvoice returns a 503.
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    // Must be a verified sender/domain in the Resend dashboard.
    from: process.env.RESEND_FROM || process.env.SMTP_FROM || 'QuickInvoice <onboarding@resend.dev>'
  },
  // Cloudflare R2 (S3-compatible) for caching rendered invoice PDFs. When any of
  // accountId/accessKeyId/secretAccessKey/bucket is missing the cache is disabled
  // and PDFs render on demand exactly as before — no behavior change.
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || '',
    // Optional explicit endpoint; defaults to https://<accountId>.r2.cloudflarestorage.com
    endpoint: process.env.R2_ENDPOINT || '',
    // Optional public base URL (custom domain / r2.dev) for serving cached PDFs
    // directly. When unset we stream bytes through the API instead.
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || '',
    // Presigned-URL lifetime in seconds (used when publicBaseUrl is unset).
    signedUrlTtlSeconds: Number(process.env.R2_SIGNED_URL_TTL_SECONDS || 900)
  }
};

export const isProduction = env.nodeEnv === 'production';

if (isProduction) {
  const missing = [];
  if (!process.env.MONGODB_URI) missing.push('MONGODB_URI');
  if (!process.env.JWT_SECRET || env.jwtSecret === 'dev-only-change-me') missing.push('JWT_SECRET');
  if (!process.env.REFRESH_TOKEN_SECRET && !process.env.JWT_SECRET) missing.push('REFRESH_TOKEN_SECRET');

  if (missing.length) {
    throw new Error(`Missing required production environment variables: ${missing.join(', ')}`);
  }
}
