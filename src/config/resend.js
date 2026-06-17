import { Resend } from 'resend';
import { env } from './env.js';

// Single shared Resend client. Returns null when no API key is configured so
// callers can surface a clear "email not configured" error instead of crashing.
let client = null;

export const getResendClient = () => {
  if (!env.resend.apiKey) return null;
  if (!client) {
    client = new Resend(env.resend.apiKey);
  }
  return client;
};

export const isEmailEnabled = () => Boolean(env.resend.apiKey);
