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
 * Installs a fetch stub. Returns { calls, restore, state } — `state` lets a test bend what the
 * fake API reports (a payment that is authorized-not-captured, a wrong amount, an outage).
 */
export const stubRazorpay = ({ orderId = 'order_TEST1', paymentId = 'pay_TEST1' } = {}) => {
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
    networkDown: false
  };

  global.fetch = async (url, options = {}) => {
    const path = String(url).replace(env.razorpay.apiBaseUrl, '');
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ path, method: options.method || 'GET', body, headers: options.headers });

    if (state.networkDown) throw new Error('socket hang up');

    const json = (status, payload) => ({ ok: status < 400, status, json: async () => payload });

    if (path === '/orders' && options.method === 'POST') {
      if (state.failCreateOrder) {
        return json(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Order creation failed' } });
      }
      state.orderAmount = body.amount;
      return json(200, { id: state.orderId, amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes });
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
