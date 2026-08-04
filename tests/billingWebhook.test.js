import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { ensureSubscription } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { authHeader, createTestContext } from './helpers/fixtures.js';
import { configureRazorpay, stubRazorpay, unconfigureRazorpay, webhookSignature } from './helpers/razorpayStub.js';

useMongoTestDb();

let razorpay;

beforeEach(() => {
  configureRazorpay();
  razorpay = stubRazorpay();
});

afterEach(() => {
  razorpay.restore();
  unconfigureRazorpay();
});

const seeded = async () => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext();
  await ensureSubscription({ business: context.business });
  return context;
};

/** Opens a real checkout so a webhook has something genuine to land on. */
const openCheckout = async (token, { planKey = 'pro', interval = 'year' } = {}) => {
  const response = await request(app).post('/api/v1/billing/checkout').set(authHeader(token)).send({ planKey, interval });
  assert.equal(response.status, 201, response.text);
  return response.body.checkout;
};

const capturedEvent = ({ orderId, paymentId = 'pay_TEST1', amount = 199900, businessId, billjiPaymentId }) => ({
  event: 'payment.captured',
  payload: {
    payment: {
      entity: {
        id: paymentId,
        order_id: orderId,
        status: 'captured',
        amount,
        currency: 'INR',
        notes: { businessId: String(businessId || ''), billjiPaymentId: String(billjiPaymentId || '') }
      }
    }
  }
});

/**
 * Posts a webhook the way Razorpay does: a raw JSON body plus an HMAC over those exact bytes.
 * `.set('content-type', ...)` + `.send(string)` keeps supertest from re-serialising the object,
 * which is what makes this a real test of the raw-body mount.
 */
const postWebhook = (body, { signature, eventId = 'evt_1', provider = 'razorpay' } = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return request(app)
    .post(`/api/v1/billing/webhooks/${provider}`)
    .set('content-type', 'application/json')
    .set('x-razorpay-signature', signature === undefined ? webhookSignature(raw) : signature)
    .set('x-razorpay-event-id', eventId)
    .send(raw);
};

describe('webhook signature verification', () => {
  it('accepts a correctly signed event', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);

    const response = await postWebhook(capturedEvent({ orderId, businessId: business._id }));
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.success, true);
  });

  it('rejects a wrong signature with 400 and changes nothing', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);

    const response = await postWebhook(capturedEvent({ orderId, businessId: business._id }), { signature: 'deadbeef' });

    assert.equal(response.status, 400);
    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'starter');
    assert.equal((await SubscriptionPayment.findOne({ business: business._id })).status, 'created');
  });

  it('rejects a signature made with the API secret instead of the webhook secret', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    const body = JSON.stringify(capturedEvent({ orderId, businessId: business._id }));

    // Anyone holding the API secret must not be able to forge an activation.
    const response = await postWebhook(body, { signature: webhookSignature(body, 'rzp_test_secret') });
    assert.equal(response.status, 400);
  });

  it('rejects a body tampered with after signing', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    const original = JSON.stringify(capturedEvent({ orderId, businessId: business._id }));
    const tampered = JSON.stringify(capturedEvent({ orderId, businessId: business._id, amount: 100 }));

    const response = await postWebhook(tampered, { signature: webhookSignature(original) });
    assert.equal(response.status, 400);
  });

  it('rejects a missing signature header', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);

    const response = await postWebhook(capturedEvent({ orderId, businessId: business._id }), { signature: '' });
    assert.equal(response.status, 400);
  });

  it('needs no session — the signature is the authentication', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);

    // No Authorization header anywhere in postWebhook.
    const response = await postWebhook(capturedEvent({ orderId, businessId: business._id }));
    assert.equal(response.status, 200);
  });

  it('reports 503 when webhooks are not configured, rather than accepting anything', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    unconfigureRazorpay();
    configureRazorpay();
    const { env } = await import('../src/config/env.js');
    env.razorpay.webhookSecret = '';

    const response = await postWebhook(capturedEvent({ orderId, businessId: business._id }));
    assert.equal(response.status, 503);
  });
});

// THE regression guard for docs §6.2. The HMAC is over the exact bytes Razorpay sent, so if the
// webhook route is ever mounted below the global express.json() in app.js, req.body arrives parsed
// and every one of these fails. That is the intended failure — the alternative is someone "fixing"
// it by disabling signature checks.
describe('raw body survives to the handler', () => {
  it('verifies a body whose key order JSON.stringify would not reproduce', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);

    // Deliberately odd spacing and key order: a parse/re-stringify round trip normalises both, so
    // this only passes if the handler saw the original bytes.
    const raw = `{ "event" : "payment.captured",\n  "payload": {"payment": {"entity": {"order_id": "${orderId}", "id": "pay_TEST1", "status": "captured", "amount": 199900}}} }`;

    const response = await postWebhook(raw, { signature: webhookSignature(raw) });
    assert.equal(response.status, 200, response.text);
    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'pro');
  });

  it('still verifies when the provider sends an unexpected content-type', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    const raw = JSON.stringify(capturedEvent({ orderId, businessId: business._id }));

    const response = await request(app)
      .post('/api/v1/billing/webhooks/razorpay')
      .set('content-type', 'text/plain')
      .set('x-razorpay-signature', webhookSignature(raw))
      .set('x-razorpay-event-id', 'evt_ct')
      .send(raw);

    assert.equal(response.status, 200, response.text);
  });
});

describe('activation via webhook', () => {
  it('activates the plan BillJi computed, not anything the event claims', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);

    // The event carries no plan, no period and no entitlements — everything below comes from the row
    // we wrote at checkout. (The amount must agree: a mismatch is refused, see the amount test below.)
    await postWebhook(capturedEvent({ orderId, businessId: business._id }));

    const subscription = await Subscription.findOne({ business: business._id });
    assert.equal(subscription.planKey, 'pro');
    assert.equal(subscription.pricing.amount, 199900, 'the price comes from our record, never from the event');
    assert.equal(subscription.entitlements.features.get('expenses'), true);

    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.status, 'captured');
    assert.equal(payment.netAmount, 199900);
    assert.equal(payment.providerRefs.paymentId, 'pay_TEST1');
  });

  it('is idempotent across redelivery of the same event', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    const event = capturedEvent({ orderId, businessId: business._id });

    const first = await postWebhook(event, { eventId: 'evt_dup' });
    const firstEnd = (await Subscription.findOne({ business: business._id })).currentPeriodEnd;
    const second = await postWebhook(event, { eventId: 'evt_dup' });
    const secondEnd = (await Subscription.findOne({ business: business._id })).currentPeriodEnd;

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(secondEnd.getTime(), firstEnd.getTime(), 'a redelivery must not extend the period again');
  });

  it('does not double-activate when a webhook races the client verify', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    const { paymentSignature } = await import('./helpers/razorpayStub.js');

    // Both arrive at once, as they genuinely can.
    const [webhook, client] = await Promise.all([
      postWebhook(capturedEvent({ orderId, businessId: business._id }), { eventId: 'evt_race' }),
      request(app)
        .post('/api/v1/billing/checkout/verify')
        .set(authHeader(token))
        .send({ orderId, paymentId: 'pay_TEST1', signature: paymentSignature({ orderId, paymentId: 'pay_TEST1' }) })
    ]);

    assert.equal(webhook.status, 200, webhook.text);
    assert.equal(client.status, 200, client.text);
    assert.equal(await SubscriptionPayment.countDocuments({ business: business._id, status: 'captured' }), 1);

    const history = await (await import('../src/models/SubscriptionHistory.js')).default.find({
      business: business._id,
      action: { $in: ['activated', 'upgraded', 'renewed'] }
    });
    assert.equal(history.length, 1, 'exactly one activation, whichever path won');
  });

  it('matches an event by the notes we attached when the order id lookup misses', async () => {
    const { token, business } = await seeded();
    const { orderId, paymentId: ourPaymentId } = await openCheckout(token);
    // Simulate having failed to persist the order id.
    await SubscriptionPayment.updateOne({ business: business._id }, { $set: { 'providerRefs.orderId': '' } });

    const response = await postWebhook(
      capturedEvent({ orderId: 'order_UNKNOWN', businessId: business._id, billjiPaymentId: ourPaymentId })
    );

    assert.equal(response.status, 200, response.text);
    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'pro');
  });
});

describe('failures and refunds', () => {
  it('records a failed payment and grants nothing', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);

    const response = await postWebhook({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_TEST1', order_id: orderId, status: 'failed', error_description: 'card declined' } } }
    });

    assert.equal(response.status, 200, response.text);
    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.status, 'failed');
    assert.equal(payment.failureReason, 'card declined');
    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'starter');
  });

  it('a refund ends access, so a refund is not a free plan', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    await postWebhook(capturedEvent({ orderId, businessId: business._id }), { eventId: 'evt_cap' });
    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'pro');

    const response = await postWebhook(
      {
        event: 'refund.processed',
        payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_TEST1', amount: 199900, status: 'processed' } } }
      },
      { eventId: 'evt_refund' }
    );

    assert.equal(response.status, 200, response.text);
    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.status, 'refunded');
    assert.equal(payment.refundedAmount, 199900);

    const subscription = await Subscription.findOne({ business: business._id });
    assert.ok(subscription.cancel.effectiveAt, 'a fully refunded period is ended');

    const view = await request(app).get('/api/v1/billing/subscription').set(authHeader(token));
    assert.equal(view.body.subscription.subscriptionStatus, 'cancelled');
    // Falls back to the free plan rather than locking the customer out of their own invoices.
    assert.equal(view.body.subscription.planKey, 'starter');
  });

  it('a partial refund leaves access intact', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    await postWebhook(capturedEvent({ orderId, businessId: business._id }), { eventId: 'evt_cap' });

    await postWebhook(
      {
        event: 'refund.processed',
        payload: { refund: { entity: { id: 'rfnd_2', payment_id: 'pay_TEST1', amount: 50000, status: 'processed' } } }
      },
      { eventId: 'evt_partial' }
    );

    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.status, 'partially_refunded');
    assert.equal(payment.refundedAmount, 50000);
    // The customer kept part of what they bought.
    assert.equal((await Subscription.findOne({ business: business._id })).cancel.effectiveAt, null);
  });

  it('dedups a redelivered refund instead of refunding twice', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    await postWebhook(capturedEvent({ orderId, businessId: business._id }), { eventId: 'evt_cap' });

    const refund = {
      event: 'refund.processed',
      payload: { refund: { entity: { id: 'rfnd_3', payment_id: 'pay_TEST1', amount: 50000, status: 'processed' } } }
    };
    await postWebhook(refund, { eventId: 'evt_r' });
    const again = await postWebhook(refund, { eventId: 'evt_r' });

    assert.equal(again.body.duplicate, true);
    assert.equal((await SubscriptionPayment.findOne({ business: business._id })).refundedAmount, 50000);
  });

  // REGRESSION (audit P0-1). Razorpay sends refund.created AND refund.processed for ONE refund, with
  // two different event ids. Dedup used to be keyed on the event id, so a single ₹500 refund was
  // recorded as ₹1000 — and two half-refunds summed to the full amount, which cancelled a
  // subscription the customer had only been half refunded for.
  it('counts one refund once even though the provider sends two events for it', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    await postWebhook(capturedEvent({ orderId, businessId: business._id }), { eventId: 'evt_cap' });

    const entity = { id: 'rfnd_PAIR', payment_id: 'pay_TEST1', amount: 50000, status: 'processed' };
    const created = await postWebhook({ event: 'refund.created', payload: { refund: { entity } } }, { eventId: 'evt_rc' });
    const processed = await postWebhook({ event: 'refund.processed', payload: { refund: { entity } } }, { eventId: 'evt_rp' });

    assert.equal(created.status, 200, created.text);
    assert.equal(processed.status, 200, processed.text);

    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.refundedAmount, 50000, 'one ₹500 refund is ₹500 refunded, not ₹1000');
    assert.equal(payment.status, 'partially_refunded');
    // The refund is claimed exactly once. The second event's id is deliberately NOT recorded: it
    // changed nothing, and a redelivery of it is deduped by the refund id regardless.
    assert.deepEqual([...payment.refundIds], ['rfnd_PAIR']);
    assert.ok(payment.webhookEventIds.includes('evt_rc'));
    // A partial refund must not end the period.
    assert.equal((await Subscription.findOne({ business: business._id })).cancel.effectiveAt, null);
  });

  // REGRESSION (audit P0-2). The second lifecycle event of a FULL refund re-ran the cancellation,
  // which threw SUBSCRIPTION_ALREADY_CANCELLED and made the webhook answer 500 — so Razorpay retried
  // a settled refund for hours.
  it('acknowledges the second event of a full refund instead of failing forever', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    await postWebhook(capturedEvent({ orderId, businessId: business._id }), { eventId: 'evt_cap' });

    const entity = { id: 'rfnd_FULL', payment_id: 'pay_TEST1', amount: 199900, status: 'processed' };
    const created = await postWebhook({ event: 'refund.created', payload: { refund: { entity } } }, { eventId: 'evt_fc' });
    const processed = await postWebhook({ event: 'refund.processed', payload: { refund: { entity } } }, { eventId: 'evt_fp' });

    assert.equal(created.status, 200, created.text);
    assert.equal(processed.status, 200, processed.text);

    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.refundedAmount, 199900);
    assert.equal(payment.status, 'refunded');
    // Still exactly one cancellation, from the first event.
    const subscription = await Subscription.findOne({ business: business._id });
    assert.ok(subscription.cancel.effectiveAt, 'a fully refunded period is ended');
  });

  it('never refunds past the captured amount, however many events arrive', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);
    await postWebhook(capturedEvent({ orderId, businessId: business._id }), { eventId: 'evt_cap' });

    for (const [index, amount] of [150000, 150000].entries()) {
      await postWebhook(
        {
          event: 'refund.processed',
          payload: { refund: { entity: { id: `rfnd_CAP${index}`, payment_id: 'pay_TEST1', amount, status: 'processed' } } }
        },
        { eventId: `evt_cap${index}` }
      );
    }

    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.refundedAmount, 199900, 'clamped to what was actually captured');
    assert.equal(payment.status, 'refunded');
  });

  // REGRESSION (audit P1-6). The client verify path always checked the amount; this path did not.
  it('refuses to activate when the event amount does not match our order', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);

    const response = await postWebhook(capturedEvent({ orderId, businessId: business._id, amount: 1 }));

    // Acknowledged — retrying cannot make the amounts agree — but nothing granted.
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.amountMismatch, true);
    assert.equal((await Subscription.findOne({ business: business._id })).planKey, 'starter');

    const payment = await SubscriptionPayment.findOne({ business: business._id });
    assert.equal(payment.status, 'created', 'an unexplained amount grants nothing');
    assert.match(payment.failureReason, /does not match/);
  });

  it('applies a capture and a later refund to the same payment — one field could not', async () => {
    const { token, business } = await seeded();
    const { orderId } = await openCheckout(token);

    await postWebhook(capturedEvent({ orderId, businessId: business._id }), { eventId: 'evt_capture' });
    await postWebhook(
      {
        event: 'refund.processed',
        payload: { refund: { entity: { id: 'rfnd_4', payment_id: 'pay_TEST1', amount: 199900, status: 'processed' } } }
      },
      { eventId: 'evt_refund' }
    );

    const payment = await SubscriptionPayment.findOne({ business: business._id });
    // Both distinct events recorded: a scalar dedup key would have lost one and let a redelivered
    // capture activate a second time.
    assert.deepEqual([...payment.webhookEventIds].sort(), ['evt_capture', 'evt_refund']);
  });
});

describe('unhandled and unmatched events', () => {
  it('acknowledges an event type we do not act on, so the provider stops retrying', async () => {
    await seeded();
    const response = await postWebhook({ event: 'payment.authorized', payload: { payment: { entity: { id: 'pay_X' } } } });

    assert.equal(response.status, 200);
    assert.equal(response.body.ignored, 'payment.authorized');
  });

  it('acknowledges a signed event that matches no payment', async () => {
    await seeded();
    const response = await postWebhook(capturedEvent({ orderId: 'order_NOT_OURS' }));

    assert.equal(response.status, 200, 'retrying will not make an unknown event known');
    assert.equal(response.body.unmatched, true);
  });

  it('rejects an unknown provider', async () => {
    await seeded();
    const response = await postWebhook(capturedEvent({ orderId: 'order_X' }), { provider: 'paypal' });
    assert.equal(response.status, 400);
  });

  it('has no webhooks for the manual provider', async () => {
    await seeded();
    const response = await postWebhook(capturedEvent({ orderId: 'order_X' }), { provider: 'manual' });
    assert.equal(response.status, 400);
  });
});
