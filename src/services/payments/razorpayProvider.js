import crypto from 'crypto';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

// Razorpay, spoken to over its REST API with global fetch and node:crypto.
//
// No SDK dependency on purpose. The whole surface we need is four calls and one HMAC, the SDK is
// a thin wrapper over exactly these endpoints, and a money path is easier to audit when the wire
// format is visible in the file. It also keeps the provider abstraction honest — a second
// provider is another file of the same shape, not another vendor SDK to learn.
//
// Razorpay ORDERS, not Razorpay Subscriptions (approved Decision 1 / D9): Subscriptions would put
// the billing cycle, plan ids and renewal dates inside Razorpay, which is the opposite of the
// requirement that BillJi owns all business logic. BillJi creates an order for an amount it
// computed and sets its own period end.

const AUTH = () => `Basic ${Buffer.from(`${env.razorpay.keyId}:${env.razorpay.keySecret}`).toString('base64')}`;

// A payment call that hangs forever holds a request open and, worse, leaves the caller unsure
// whether money moved. Fail fast and let the client retry through our idempotency layer.
const TIMEOUT_MS = 15000;

const call = async (path, { method = 'GET', body } = {}) => {
  let response;
  try {
    response = await fetch(`${env.razorpay.apiBaseUrl}${path}`, {
      method,
      headers: { Authorization: AUTH(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    throw new ApiError(502, 'Could not reach the payment provider. Please try again.', {
      code: 'PROVIDER_UNREACHABLE',
      cause: error.message
    });
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const description = payload?.error?.description || 'Payment provider rejected the request';
    // Razorpay's own message is safe to surface — it is written for end users ("card declined").
    throw new ApiError(response.status === 400 ? 400 : 502, description, {
      code: payload?.error?.code || 'PROVIDER_ERROR',
      providerReason: payload?.error?.reason || ''
    });
  }

  return payload;
};

const timingSafeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length. Compare lengths
  // first and still run the constant-time compare on the equal-length path.
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const hmac = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

export const razorpayProvider = {
  name: 'razorpay',

  isConfigured: () => Boolean(env.razorpay.keyId && env.razorpay.keySecret),

  /** Checkout needs the public key id; the secret never leaves the server. */
  publicConfig: () => ({ keyId: env.razorpay.keyId }),

  /**
   * @param {{amount:number, currency:string, receipt:string, notes:object}} input amount in paise
   */
  createOrder: async ({ amount, currency = 'INR', receipt, notes = {} }) => {
    const order = await call('/orders', {
      method: 'POST',
      body: {
        amount,
        currency,
        receipt,
        // Razorpay must not capture partially: we sell a fixed-price period, so a partial payment
        // is not a smaller subscription, it is an unpaid one.
        payment_capture: 1,
        notes
      }
    });

    return { providerOrderId: order.id, amount: order.amount, currency: order.currency, raw: order };
  },

  /**
   * Confirms the client-reported payment really came from Razorpay.
   *
   * The signature covers `order_id|payment_id` only — it proves the pair is genuine, not what was
   * paid. The amount is safe regardless because the order we created fixed it, and billingService
   * additionally re-fetches the payment before activating anything.
   */
  verifyPaymentSignature: ({ orderId, paymentId, signature }) =>
    timingSafeEqual(hmac(`${orderId}|${paymentId}`, env.razorpay.keySecret), signature),

  fetchPayment: async (paymentId) => {
    const payment = await call(`/payments/${encodeURIComponent(paymentId)}`);
    return {
      paymentId: payment.id,
      orderId: payment.order_id,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      captured: payment.status === 'captured',
      method: payment.method,
      raw: payment
    };
  },

  /** amount omitted = full refund. Razorpay rejects a refund larger than the captured amount. */
  refund: async ({ paymentId, amount = null, notes = {} }) => {
    const refund = await call(`/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: 'POST',
      body: { ...(amount === null ? {} : { amount }), notes }
    });

    return { refundId: refund.id, amount: refund.amount, status: refund.status, raw: refund };
  },

  /**
   * Verifies and parses a webhook.
   *
   * The HMAC is over the EXACT RAW BYTES. A body that has been JSON-parsed and re-stringified will
   * not match, which is why the webhook route is mounted with express.raw() ahead of the global
   * express.json() in app.js. If that mount ever regresses, every webhook starts failing here —
   * loudly, which is the correct direction to fail.
   */
  parseWebhook: ({ rawBody, headers }) => {
    if (!env.razorpay.webhookSecret) {
      throw new ApiError(503, 'Webhooks are not configured', { code: 'WEBHOOK_NOT_CONFIGURED' });
    }

    const signature = headers['x-razorpay-signature'];
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));

    if (!timingSafeEqual(hmac(body, env.razorpay.webhookSecret), signature)) {
      throw new ApiError(400, 'Invalid webhook signature', { code: 'WEBHOOK_SIGNATURE_INVALID' });
    }

    const payload = JSON.parse(body.toString('utf8'));
    const payment = payload?.payload?.payment?.entity || null;
    const refund = payload?.payload?.refund?.entity || null;
    const order = payload?.payload?.order?.entity || null;

    return {
      // Razorpay's own delivery id. Redeliveries repeat it, which is what makes dedup possible.
      eventId: headers['x-razorpay-event-id'] || `${payload.event}:${payment?.id || refund?.id || order?.id || ''}`,
      event: payload.event,
      paymentId: payment?.id || refund?.payment_id || '',
      orderId: payment?.order_id || order?.id || '',
      refundId: refund?.id || '',
      amount: refund?.amount ?? payment?.amount ?? null,
      status: payment?.status || refund?.status || '',
      failureReason: payment?.error_description || '',
      raw: payload
    };
  }
};

export default razorpayProvider;
