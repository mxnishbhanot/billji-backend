import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env.js';

const parseDurationMs = (value, fallbackMs) => {
  if (typeof value === 'number') return value * 1000;
  const match = String(value || '').match(/^(\d+)([smhd])$/);
  if (!match) return fallbackMs;

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * multipliers[unit];
};

export const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const signAccessToken = ({ userId, sessionId }) =>
  jwt.sign({ sub: userId.toString(), sid: sessionId?.toString(), jti: crypto.randomUUID(), typ: 'access' }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn
  });

export const signRefreshToken = ({ userId, sessionId, refreshTokenId }) =>
  jwt.sign({ sub: userId.toString(), sid: sessionId.toString(), jti: refreshTokenId, typ: 'refresh' }, env.refreshTokenSecret, {
    expiresIn: env.refreshTokenExpiresIn
  });

export const signToken = (userId, sessionId) => signAccessToken({ userId, sessionId });
export const verifyToken = (token) => jwt.verify(token, env.jwtSecret);
export const verifyRefreshToken = (token) => jwt.verify(token, env.refreshTokenSecret);
export const refreshTokenExpiresAt = () => new Date(Date.now() + parseDurationMs(env.refreshTokenExpiresIn, 30 * 24 * 60 * 60 * 1000));
