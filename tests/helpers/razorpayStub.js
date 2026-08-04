import crypto from 'crypto';
import { env } from '../../src/config/env.js';

// Razorpay, faked at the HTTP boundary.
//
// The provider talks to the real API with global fetch, so stubbing fetch exercises everything that
// matters — URL, method, Basic auth, body shape, error mapping, and the real HMAC code paths using
// node:crypto. Stubbing the provider module instead would test nothing but our own test double.

export const KEY_ID = 'rzp_test_key';
export const KEY_SECRET = 'rzp_test_secret';
export const WEBHOOK_SECRET = 'rzp_test_webhook_secret';

/** Points env at the fake credentials so getProvider() reports razorpay as configured. */
export const configureRazorpay = () => {
  env.razorpay.keyId = KEY_ID;
  env.razorpay.keySecret = KEY_SECRET;
  env.razorpay.webhookSecret = WEBHOOK_SECRET;
};

export const unconfigureRazorpay = () => {
  env.razorpay.keyId = '';
  env.razorpay.keySecret = '';
  env.razorpay.webhookSecret = '';
};

export const paymentSignature = ({ orderId, paymentId, secret = KEY_SECRET }) =>
  crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

export const webhookSignature = (body, secret = WEBHOOK_SECRET) =>
  crypto.createHmac('sha256', secret).update(typeof body === 'string' ? body : JSON.stringify(body)).digest('hex');

/**
 * The mandate-authentication signature. NOTE THE OPERAND ORDER — `payment_id|subscription_id`, the
 * reverse of paymentSignature's `order_id|payment_id`. Written out separately here for the same reason
 * the provider has two functions: a test that quietly used the wrong order would "prove" a bypass works.
 */
export const mandateSignature = ({ subscriptionId, paymentId, secret = KEY_SECRET }) =>
  crypto.createHmac('sha256', secret).update(`${paymentId}|${subscriptionId}`).digest('hex');

/** A `subscription.*` webhook body. `charged` carries BOTH entities, exactly as Razorpay sends it. */
export const autopayEvent = ({
  event,
  subscriptionId = 'sub_TEST1',
  paymentId = 'pay_CYCLE1',
  amount = null,
  status = 'active',
  chargeAt = null,
  currentEnd = null,
  notes = {},
  method = 'upi'
}) => ({
  event,
  payload: {
    subscription: {
      entity: {
        id: subscriptionId,
        status,
        notes,
        customer_id: 'cust_TEST1',
        ...(chargeAt ? { charge_at: Math.floor(chargeAt.getTime() / 1000) } : {}),
        ...(currentEnd ? { current_end: Math.floor(currentEnd.getTime() / 1000) } : {})
      }
    },
    ...(event === 'subscription.charged'
      ? { payment: { entity: { id: paymentId, subscription_id: subscriptionId, status: 'captured', amount, method } } }
      : {})
  }
});

/**
 * Installs a fetch stub. Returns { calls, restore, state } — `state` lets a test bend what the
 * fake API reports (a payment that is authorized-not-captured, a wrong amount, an outage).
 */
export const stubRazorpay = ({ orderId = 'order_TEST1', paymentId = 'pay_TEST1', subscriptionId = 'sub_TEST1' } = {}) => {
  const realFetch = global.fetch;
  const calls = [];
  const state = {
    orderId,
    paymentId,
    // Set by createOrder, read back by fetchPayment, so amount agreement is genuinely round-tripped.
    orderAmount: 0,
    paymentStatus: 'captured',
    // Overrides orderAmount when set — how a test simulates a tampered amount.
    paymentAmount: null,
    failCreateOrder: false,
    networkDown: false,
    unauthorized: false,

    // --- autopay ---------------------------------------------------------------------------
    subscriptionId,
    customerId: 'cust_TEST1',
    // Every provider plan minted this run, so a test can assert the plan-id cache hit or missed.
    planIds: [],
    // What GET /subscriptions/:id reports. Bend it to simulate a mandate that halted, completed, or
    // kept charging without telling us.
    remoteSubscription: { status: 'active', paid_count: 1, current_end: null, charge_at: null },
    cancelledAtCycleEnd: null,
    failCreatePlan: false,
    failCreateSubscription: false,
    failCancelSubscription: false
  };

  global.fetch = async (url, options = {}) => {
    const path = String(url).replace(env.razorpay.apiBaseUrl, '');
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ path, method: options.method || 'GET', body, headers: options.headers });

    if (state.networkDown) throw new Error('socket hang up');

    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });

    // Wrong key, or a product this account does not have enabled (Subscriptions is a separate
    // activation from Orders). Razorpay answers with a bare string here, NOT its usual
    // { error: { description } } — which is why the provider needs its own branch for it.
    if (state.unauthorized) return json(401, { error: 'Unauthorized' });

    if (path === '/orders' && options.method === 'POST') {
      if (state.failCreateOrder) {
        return json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Order creation failed' } });
      }
      state.orderAmount = body.amount;
      return json(200, { id: state.orderId, amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes });
    }

    // --- autopay: plans, subscriptions, mandates -------------------------------------------
    if (path === '/plans' && options.method === 'POST') {
      if (state.failCreatePlan) {
        return json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Plan creation failed' } });
      }
      // A distinct id per (period, amount) pair, so a test can prove the cache keyed on the AMOUNT and
      // that a price change mints a new provider plan rather than reusing the old one.
      const planId = `plan_${body.period}_${body.item.amount}`;
      state.planIds.push(planId);
      return json(200, { id: planId, period: body.period, interval: body.interval, item: body.item });
    }

    if (path === '/subscriptions' && options.method === 'POST') {
      if (state.failCreateSubscription) {
        return json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Subscription creation failed' } });
      }
      state.remoteSubscription = { ...state.remoteSubscription, plan_id: body.plan_id, total_count: body.total_count, notes: body.notes };
      return json(200, {
        id: state.subscriptionId,
        status: 'created',
        plan_id: body.plan_id,
        total_count: body.total_count,
        customer_id: state.customerId,
        notes: body.notes
      });
    }

    if (path.startsWith('/subscriptions/') && path.endsWith('/cancel')) {
      if (state.failCancelSubscription) {
        return json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The subscription could not be cancelled' } });
      }
      state.remoteSubscription.status = body.cancel_at_cycle_end ? 'active' : 'cancelled';
      state.cancelledAtCycleEnd = Boolean(body.cancel_at_cycle_end);
      return json(200, { id: state.subscriptionId, status: 'cancelled' });
    }

    if (path.startsWith('/subscriptions/')) {
      return json(200, { id: state.subscriptionId, customer_id: state.customerId, ...state.remoteSubscription });
    }

    if (path.startsWith('/payments/') && path.endsWith('/refund')) {
      return json(200, { id: 'rfnd_TEST1', amount: body.amount ?? state.orderAmount, status: 'processed' });
    }

    if (path.startsWith('/payments/')) {
      return json(200, {
        id: state.paymentId,
        order_id: state.orderId,
        status: state.paymentStatus,
        amount: state.paymentAmount ?? state.orderAmount,
        currency: 'INR',
        method: 'upi'
      });
    }

    return json(404, { error: { code: 'NOT_FOUND', description: `unstubbed ${options.method || 'GET'} ${path}` } });
  };

  return { calls, state, restore: () => { global.fetch = realFetch; } };
};
