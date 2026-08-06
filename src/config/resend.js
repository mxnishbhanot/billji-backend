import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import { env } from './env.js';

// Single shared Resend client. Returns null when no API key is configured so
// callers can surface a clear "email not configured" error instead of crashing.
let client = null;

// Dev-only SMTP escape hatch. Resend's shared `onboarding@resend.dev` sender only
// delivers to the Resend account owner, so team invites to a tester's address are
// accepted and then dropped — which makes the invite flow untestable until a
// domain is verified. Setting SMTP_HOST (e.g. Gmail) routes mail through plain
// SMTP instead, which will deliver anywhere.
//
// Production leaves SMTP_HOST unset and keeps using Resend.
let smtpClient = null;

// Mimics the slice of the Resend SDK the email service uses: `.emails.send(...)`
// resolving to `{ data, error }` rather than throwing. Keeps every caller in
// emailService.js identical across both providers.
const buildSmtpClient = () => {
  const transport = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined
  });

  return {
    emails: {
      send: async ({ from, to, subject, html, text, attachments }) => {
        try {
          const info = await transport.sendMail({
            from,
            to,
            subject,
            html,
            text,
            // Resend takes `content`; nodemailer takes `content` too, but only
            // accepts Buffer/string — which is what invoicePdfCache returns.
            attachments: attachments?.map(({ filename, content }) => ({ filename, content }))
          });
          return { data: { id: info.messageId }, error: null };
        } catch (err) {
          return { data: null, error: { message: err?.message || String(err), name: err?.name } };
        }
      }
    }
  };
};

export const getResendClient = () => {
  if (env.smtp.host) {
    if (!smtpClient) smtpClient = buildSmtpClient();
    return smtpClient;
  }
  if (!env.resend.apiKey) return null;
  if (!client) {
    client = new Resend(env.resend.apiKey);
  }
  return client;
};

export const isEmailEnabled = () => Boolean(env.smtp.host || env.resend.apiKey);
