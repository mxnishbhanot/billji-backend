import { env } from '../config/env.js';
import { getResendClient } from '../config/resend.js';
import { ApiError } from '../utils/ApiError.js';
import { getOrRenderInvoicePdf } from './invoicePdfCache.js';

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const formatAmount = (amount) => {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 2
    }).format(value);
  } catch {
    return `₹${value.toFixed(2)}`;
  }
};

// Strip any RFC-5322 quoting/comment chars a business name might contain so it
// can't break the From header.
const sanitizeDisplayName = (name = '') =>
  String(name).replace(/[<>"\r\n]/g, '').trim();

// Extract the bare address (the <…> part) from the configured RESEND_FROM, e.g.
// "BillJi Dev <onboarding@resend.dev>" -> "onboarding@resend.dev". This is the
// only part the sending domain must keep verified; the display name is free.
const fromAddress = () => {
  const raw = env.resend.from || '';
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1].trim() : raw.trim();
};

// Sender header: show the business name to the recipient, keep the verified
// address. Falls back to the configured RESEND_FROM verbatim when no business.
const resolveFrom = (business) => {
  const name = sanitizeDisplayName(business?.businessName);
  const address = fromAddress();
  if (name && address) return `${name} <${address}>`;
  return env.resend.from;
};

const formatDate = (date) => {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(date));
  } catch {
    return '';
  }
};

// Lightweight, email-client-safe template: tables + inline styles only (no
// external CSS, no flexbox/grid). Renders cleanly in Gmail/Outlook/Apple Mail.
const buildInvoiceEmailHtml = ({ invoice, business }) => {
  const brand = escapeHtml(business?.businessName || 'QuickInvoice');
  const customerName = escapeHtml(invoice.customerSnapshot?.name || 'there');
  const number = escapeHtml(invoice.invoiceNumber || invoice.documentNumber || '');
  const total = formatAmount(invoice.total);
  const issuedOn = formatDate(invoice.date);
  const dueOn = formatDate(invoice.dueDate);

  const detailRow = (label, value) =>
    value
      ? `<tr>
          <td style="padding:6px 0;color:#6b7280;font-size:14px;">${label}</td>
          <td style="padding:6px 0;color:#111827;font-size:14px;font-weight:600;text-align:right;">${value}</td>
        </tr>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr>
            <td style="background-color:#111827;padding:24px 32px;">
              <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.2px;">${brand}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 8px;color:#111827;font-size:16px;">Hi ${customerName},</p>
              <p style="margin:0 0 24px;color:#4b5563;font-size:15px;line-height:22px;">
                Thank you for your business. Your invoice <strong>${number}</strong> is ready and attached to this email as a PDF.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;">
                ${detailRow('Invoice', number)}
                ${detailRow('Issued', issuedOn)}
                ${detailRow('Due', dueOn)}
                <tr><td colspan="2" style="border-top:1px solid #e5e7eb;padding-top:12px;"></td></tr>
                <tr>
                  <td style="padding:6px 0;color:#111827;font-size:15px;font-weight:600;">Amount due</td>
                  <td style="padding:6px 0;color:#111827;font-size:18px;font-weight:700;text-align:right;">${total}</td>
                </tr>
              </table>
              <p style="margin:24px 0 0;color:#9ca3af;font-size:13px;line-height:20px;">
                The full invoice is attached as a PDF. If you have any questions about this invoice, simply reply to this email.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;" align="center">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                Invoice from <strong style="color:#6b7280;">${brand}</strong>, powered by
                <strong style="color:#111827;">Bill<span style="color:#f97316;">Ji</span></strong>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

// BillJi-branded one-time-code email. Same table+inline-style approach as the
// invoice email so it renders in Gmail/Outlook/Apple Mail. No business context
// here — this is a BillJi account email, so the BillJi wordmark is the brand.
const buildPasswordResetEmailHtml = ({ name, code, ttlMinutes }) => {
  const safeName = escapeHtml(name || 'there');
  const safeCode = escapeHtml(code);

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr>
            <td style="background-color:#1C1A4A;padding:24px 32px;" align="center">
              <span style="font-size:26px;font-weight:800;letter-spacing:-1px;">
                <span style="color:#ffffff;">Bill</span><span style="color:#FF8A1F;">Ji</span>
              </span>
              <div style="margin-top:4px;color:#C3C0FF;font-size:12px;font-weight:600;">Hisaab Apka, Growth Apki</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 8px;color:#111827;font-size:16px;">Hi ${safeName},</p>
              <p style="margin:0 0 24px;color:#4b5563;font-size:15px;line-height:22px;">
                We received a request to reset your BillJi password. Enter the code below in the app to set a new password.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:#f5f4ff;border:1px solid #ddd9ff;border-radius:10px;padding:20px;">
                    <div style="color:#6b7280;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Your reset code</div>
                    <div style="color:#1C1A4A;font-size:34px;font-weight:800;letter-spacing:10px;">${safeCode}</div>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;color:#4b5563;font-size:14px;line-height:21px;">
                This code expires in <strong>${ttlMinutes} minutes</strong>. If you didn't request a password reset, you can safely ignore this email — your password won't change.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;" align="center">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                Sent by <strong style="color:#111827;">Bill<span style="color:#FF8A1F;">Ji</span></strong> · Please don't reply to this email
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

// Two-factor verification-code email. Same BillJi-branded, email-client-safe
// layout as the reset email; the purpose line changes with the flow.
const buildTwoFactorEmailHtml = ({ name, code, ttlMinutes, purpose }) => {
  const safeName = escapeHtml(name || 'there');
  const safeCode = escapeHtml(code);
  const intro =
    purpose === 'enroll'
      ? 'Enter the code below to turn on email two-factor authentication for your BillJi account.'
      : purpose === 'manage'
        ? 'Enter the code below to confirm this change to your two-factor settings.'
        : 'Enter the code below to finish signing in to your BillJi account.';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr>
            <td style="background-color:#1C1A4A;padding:24px 32px;" align="center">
              <span style="font-size:26px;font-weight:800;letter-spacing:-1px;">
                <span style="color:#ffffff;">Bill</span><span style="color:#FF8A1F;">Ji</span>
              </span>
              <div style="margin-top:4px;color:#C3C0FF;font-size:12px;font-weight:600;">Hisaab Apka, Growth Apki</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 8px;color:#111827;font-size:16px;">Hi ${safeName},</p>
              <p style="margin:0 0 24px;color:#4b5563;font-size:15px;line-height:22px;">${intro}</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="background-color:#f5f4ff;border:1px solid #ddd9ff;border-radius:10px;padding:20px;">
                    <div style="color:#6b7280;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Your verification code</div>
                    <div style="color:#1C1A4A;font-size:34px;font-weight:800;letter-spacing:10px;">${safeCode}</div>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;color:#4b5563;font-size:14px;line-height:21px;">
                This code expires in <strong>${ttlMinutes} minutes</strong>. If you didn't request it, someone may have your password — sign in and change it right away.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;" align="center">
              <p style="margin:0;color:#9ca3af;font-size:12px;">
                Sent by <strong style="color:#111827;">Bill<span style="color:#FF8A1F;">Ji</span></strong> · Please don't reply to this email
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

// Sends a 2FA verification code to the account email. Throws ApiError if Resend
// isn't configured or the send fails so the caller can surface it.
export const sendTwoFactorCodeEmail = async ({ to, name, code, ttlMinutes, purpose = 'login' }) => {
  if (!to) throw new ApiError(422, 'Account email is required to send verification code');

  const resend = getResendClient();
  if (!resend) throw new ApiError(503, 'Email service is not configured');

  const { error } = await resend.emails.send({
    from: env.resend.from,
    to,
    subject: `${code} is your BillJi verification code`,
    html: buildTwoFactorEmailHtml({ name, code, ttlMinutes, purpose }),
    text: `Hi ${name || 'there'}, your BillJi verification code is ${code}. It expires in ${ttlMinutes} minutes. If you didn't request it, change your password.`
  });

  if (error) {
    throw new ApiError(502, `Failed to send verification email: ${error.message || error.name || 'unknown error'}`);
  }

  return { recipient: to };
};

// Sends the reset code to the account email. Throws ApiError if Resend isn't
// configured or the send fails so the caller can decide how to surface it.
export const sendPasswordResetEmail = async ({ to, name, code, ttlMinutes }) => {
  if (!to) throw new ApiError(422, 'Account email is required to send reset code');

  const resend = getResendClient();
  if (!resend) throw new ApiError(503, 'Email service is not configured');

  const { error } = await resend.emails.send({
    from: env.resend.from,
    to,
    subject: `${code} is your BillJi password reset code`,
    html: buildPasswordResetEmailHtml({ name, code, ttlMinutes }),
    text: `Hi ${name || 'there'}, your BillJi password reset code is ${code}. It expires in ${ttlMinutes} minutes. If you didn't request this, ignore this email.`
  });

  if (error) {
    throw new ApiError(502, `Failed to send reset email: ${error.message || error.name || 'unknown error'}`);
  }

  return { recipient: to };
};

// Sends a team invitation with the raw acceptance token. Mirrors the reset-email
// path: throws ApiError if Resend isn't configured or the send fails.
// BillJi is app-only (no web panel), so acceptance happens inside the app via the
// invite code — not a clickable web link. The email leads with the code and tells
// the invitee to open the app -> "Have an invite code?" -> paste it. appUrl (Play
// Store / download link) is included only when configured.
export const sendTeamInviteEmail = async ({ to, businessName, inviterName, roleName, token, appUrl, ttlDays }) => {
  if (!to) throw new ApiError(422, 'Invitee email is required to send invitation');

  const resend = getResendClient();
  if (!resend) throw new ApiError(503, 'Email service is not configured');

  const installHtml = appUrl ? `<p>Don't have the app yet? <a href="${appUrl}">Get BillJi</a>.</p>` : '';
  const installText = appUrl ? ` Get the app: ${appUrl}.` : '';
  const { error } = await resend.emails.send({
    from: env.resend.from,
    to,
    subject: `You've been invited to ${businessName || 'a business'} on BillJi`,
    html: `<p>Hi,</p><p>${inviterName || 'A teammate'} invited you to join <strong>${businessName || 'their business'}</strong> on BillJi as <strong>${roleName || 'a member'}</strong>.</p><p>Open the BillJi app, tap <strong>"Have an invite code?"</strong> and paste this code:</p><p style="font-size:20px;font-weight:bold;letter-spacing:1px">${token}</p>${installHtml}<p>This invitation expires in ${ttlDays} days.</p>`,
    text: `${inviterName || 'A teammate'} invited you to join ${businessName || 'their business'} on BillJi as ${roleName || 'a member'}. Open the BillJi app, tap "Have an invite code?" and paste this code: ${token}.${installText} Expires in ${ttlDays} days.`
  });

  if (error) {
    throw new ApiError(502, `Failed to send invitation email: ${error.message || error.name || 'unknown error'}`);
  }

  return { recipient: to };
};

export const sendInvoiceEmail = async ({ invoice, business, to }) => {
  const recipient = to || invoice.customerSnapshot.email;

  if (!recipient) {
    throw new ApiError(422, 'Customer email is required to send invoice');
  }

  const resend = getResendClient();

  if (!resend) {
    throw new ApiError(503, 'Email service is not configured');
  }

  // Reuse the cached PDF when available; render+cache otherwise.
  const pdf = await getOrRenderInvoicePdf(invoice, business);

  const { error } = await resend.emails.send({
    from: resolveFrom(business),
    to: recipient,
    subject: `Invoice ${invoice.invoiceNumber} from ${business?.businessName || 'QuickInvoice'}`,
    html: buildInvoiceEmailHtml({ invoice, business }),
    text: `Hi ${invoice.customerSnapshot.name}, thank you for your business. Your invoice ${invoice.invoiceNumber} (amount due ${formatAmount(invoice.total)}) is attached as a PDF.`,
    attachments: [
      {
        filename: `${invoice.invoiceNumber}.pdf`,
        content: pdf
      }
    ]
  });

  if (error) {
    throw new ApiError(502, `Failed to send invoice email: ${error.message || error.name || 'unknown error'}`);
  }

  invoice.emailedAt = new Date();
  await invoice.save();

  return { recipient };
};
