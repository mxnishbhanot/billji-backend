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
// TWO mechanisms, deliberately, because they answer different questions:
//
//   Orders        — one-time payment. The money path for every manual purchase, every coupon and
//                   every prorated upgrade: BillJi computes an amount and asks for exactly that.
//   Subscriptions — the MANDATE path (UPI Autopay / card e-mandate), list price only. Razorpay
//                   holds the mandate, sends the RBI pre-debit notification, retries a failed
//                   debit, and tells us `subscription.charged` when money actually moved.
//
// This revises Decision 1 / D9, which originally chose Orders alone and accepted "no auto-renew" as
// the consequence (docs §6.1 said out loud: if auto-renew is required, say so — it changes this
// interface). It does not reverse D9's actual requirement. BillJi still owns plans, entitlements,
// trials, grace and — critically — every period end: a `charged` event is turned into a period by
// the same applyCapturedPayment -> applyPlan funnel a manual renewal uses. What Razorpay is now
// allowed to own is the CRON, not the business logic.
//
// Recurring amounts are never read from an event. The amount the customer authorised is written to
// `Subscription.autopay.chargeAmount` at enrolment, before any debit, and a charge that disagrees
// with it grants nothing (see services/autopayService.js).

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
    // 401/403 does not carry Razorpay's usual { error: { description } } — a plain
    // `{"error":"Unauthorized"}` — so it would otherwise surface as a reasonless 502. It has one of two
    // causes and both are deployment facts, not customer errors: wrong credentials, or an account
    // without that product enabled. Subscriptions (autopay) is a separate activation from Orders, so a
    // key that takes one-time payments happily can still 401 on /plans and /subscriptions.
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(502, 'Online payments are not available right now', {
        code: 'PROVIDER_UNAUTHORIZED',
        providerReason: `Razorpay refused ${method} ${path} (${response.status}). Check the API key, and that this account has the required product enabled.`
      });
    }

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

// Razorpay's own vocabulary for a billing period. BillJi's intervals are the source of truth; this
// map is the only place the two meet.
const RAZORPAY_PERIOD = { month: 'monthly', year: 'yearly' };

export const razorpayProvider = {
  name: 'razorpay',

  supportsAutopay: true,

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

  // ---------------------------------------------------------------------------
  // Autopay: mandate lifecycle
  // ---------------------------------------------------------------------------

  /**
   * A Razorpay plan for one (interval, amount) pair.
   *
   * Razorpay plans are IMMUTABLE — there is no update endpoint. A price change therefore needs a new
   * plan, which is why the caller keys its cache on the amount rather than the interval alone
   * (billingService.providerPlanKey). Nothing here invalidates: mandates already running still point
   * at the old plan, and Razorpay owns that link.
   */
  ensureProviderPlan: async ({ name, amount, currency = 'INR', interval, intervalCount = 1 }) => {
    const period = RAZORPAY_PERIOD[interval];
    if (!period) {
      // Not an ApiError: a caller asking for a lifetime/custom mandate is our bug, not a user's.
      throw new Error(`Razorpay has no recurring period for interval "${interval}"`);
    }

    const plan = await call('/plans', {
      method: 'POST',
      body: { period, interval: intervalCount, item: { name, amount, currency } }
    });

    return { providerPlanId: plan.id, raw: plan };
  },

  /**
   * Creates the mandate request. The customer still has to authenticate it — this returns a
   * subscription in `created`, and `subscription.authenticated` is what says the bank agreed.
   *
   * `customer_notify: 1` puts the RBI-mandated pre-debit notification on Razorpay, which is the
   * whole reason this path exists instead of BillJi-scheduled token debits.
   *
   * No `max_amount`: Razorpay's default ceiling is the plan amount, so the figure disclosed to the
   * customer at consent IS their plan price. No custom headroom means nothing extra to disclose.
   */
  createSubscription: async ({ providerPlanId, totalCount, notes = {} }) => {
    const subscription = await call('/subscriptions', {
      method: 'POST',
      body: {
        plan_id: providerPlanId,
        total_count: totalCount,
        quantity: 1,
        customer_notify: 1,
        notes
      }
    });

    return {
      providerSubscriptionId: subscription.id,
      status: subscription.status,
      // Absent until the mandate authenticates; mirrored when it shows up.
      customerId: subscription.customer_id || '',
      raw: subscription
    };
  },

  /** Read-back for the reconciliation job. Never used to grant a period — only to detect drift. */
  fetchSubscription: async (providerSubscriptionId) => {
    const subscription = await call(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      currentEnd: subscription.current_end ? new Date(subscription.current_end * 1000) : null,
      chargeAt: subscription.charge_at ? new Date(subscription.charge_at * 1000) : null,
      paidCount: subscription.paid_count ?? 0,
      customerId: subscription.customer_id || '',
      raw: subscription
    };
  },

  /**
   * Stops the mandate. `atCycleEnd` leaves the period the customer already paid for intact — which
   * is what BillJi's own cancellation does, so the two agree by default.
   */
  cancelProviderSubscription: async ({ providerSubscriptionId, atCycleEnd = true }) => {
    const subscription = await call(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}/cancel`, {
      method: 'POST',
      body: { cancel_at_cycle_end: atCycleEnd ? 1 : 0 }
    });

    return { status: subscription.status, raw: subscription };
  },

  /**
   * The mandate-authentication signature.
   *
   * NOTE THE OPERAND ORDER: `payment_id|subscription_id`, the REVERSE of the one-time flow's
   * `order_id|payment_id`. This is a separate function rather than a flag on
   * verifyPaymentSignature precisely because getting that order wrong is a signature bypass that
   * still looks like it validates.
   */
  verifyMandateSignature: ({ subscriptionId, paymentId, signature }) =>
    timingSafeEqual(hmac(`${paymentId}|${subscriptionId}`, env.razorpay.keySecret), signature),

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
      // Set on a recurring debit; '' for a one-time payment. Lets a mandate confirmation check that
      // the payment it was handed really belongs to that mandate.
      subscriptionId: payment.subscription_id || '',
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
    // Present on every subscription.* event. `subscription.charged` carries BOTH this and a payment
    // entity, which is why the payment/amount extraction below needs no autopay special case.
    const subscription = payload?.payload?.subscription?.entity || null;
    const unix = (seconds) => (seconds ? new Date(seconds * 1000) : null);

    return {
      // Razorpay's own delivery id. Redeliveries repeat it, which is what makes dedup possible.
      eventId:
        headers['x-razorpay-event-id'] ||
        `${payload.event}:${payment?.id || refund?.id || order?.id || subscription?.id || ''}`,
      event: payload.event,
      paymentId: payment?.id || refund?.payment_id || '',
      orderId: payment?.order_id || order?.id || '',
      refundId: refund?.id || '',
      amount: refund?.amount ?? payment?.amount ?? null,
      status: payment?.status || refund?.status || '',
      failureReason: payment?.error_description || '',
      // Autopay. `subscriptionStatus` is Razorpay's word for the mandate state; autopayService maps it
      // to BillJi's own vocabulary rather than storing it raw.
      subscriptionId: subscription?.id || payment?.subscription_id || '',
      subscriptionStatus: subscription?.status || '',
      subscriptionCurrentEnd: unix(subscription?.current_end),
      subscriptionChargeAt: unix(subscription?.charge_at),
      subscriptionEntity: subscription,
      raw: payload
    };
  }
};

export default razorpayProvider;
