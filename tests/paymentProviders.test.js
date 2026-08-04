import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import { nextReceiptNumber, prorationCredit, refundPayment } from '../src/services/billingService.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { availableProviders, getAutopayProvider, getProvider } from '../src/services/payments/index.js';
import { applyPlan, ensureSubscription, resolveStatus } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { createTestContext } from './helpers/fixtures.js';
import { configureRazorpay, stubRazorpay, unconfigureRazorpay } from './helpers/razorpayStub.js';

useMongoTestDb();

const DAY = 24 * 60 * 60 * 1000;
let razorpay;

beforeEach(() => {
  configureRazorpay();
  razorpay = stubRazorpay();
});

afterEach(() => {
  razorpay.restore();
  unconfigureRazorpay();
});

describe('provider registry', () => {
  it('rejects an unknown provider', () => {
    assert.throws(() => getProvider('paypal'), /Unknown payment provider/);
  });

  it('refuses an unconfigured provider with 503 rather than returning a stub', () => {
    unconfigureRazorpay();
    assert.throws(() => getProvider('razorpay'), (error) => error.statusCode === 503);
  });

  it('lists only configured providers', () => {
    assert.deepEqual(availableProviders().sort(), ['manual', 'razorpay']);
    unconfigureRazorpay();
    assert.deepEqual(availableProviders(), ['manual']);
  });

  it('never exposes a secret through publicConfig', () => {
    assert.deepEqual(Object.keys(getProvider('razorpay').publicConfig()), ['keyId']);
  });

  it('gates autopay on a declared capability, not on duck-typing', () => {
    // A flag reads as a decision; `typeof provider.createSubscription === 'function'` reads as an
    // accident and would start answering true the day someone lands a half-finished method.
    assert.equal(getAutopayProvider('razorpay').name, 'razorpay');
    assert.throws(() => getAutopayProvider('manual'), (error) => error.details?.code === 'PROVIDER_NO_AUTOPAY');
  });

  it('still refuses an unconfigured provider on the autopay path', () => {
    unconfigureRazorpay();
    assert.throws(() => getAutopayProvider('razorpay'), (error) => error.statusCode === 503);
  });
});

describe('manual provider', () => {
  const manual = () => getProvider('manual');

  it('is always available — money can arrive by bank transfer with no gateway', () => {
    unconfigureRazorpay();
    assert.equal(manual().isConfigured(), true);
  });

  it('mints a reference for the customer to quote on the transfer', async () => {
    const order = await manual().createOrder({ amount: 499900, currency: 'INR', receipt: 'BILLJI/2026-27/000001' });
    assert.match(order.providerOrderId, /^manual_/);
    assert.equal(order.amount, 499900);
  });

  it('never verifies client-side — a human must confirm the money landed', () => {
    assert.equal(manual().verifyPaymentSignature({ orderId: 'x', paymentId: 'y', signature: 'z' }), false);
  });

  it('has no webhooks and nothing to fetch', async () => {
    assert.throws(() => manual().parseWebhook({}), /no webhooks/);
    await assert.rejects(manual().fetchPayment('x'), /no provider record/);
  });

  it('cannot hold a mandate, and does not pretend to', () => {
    // Undefined rather than throwing stubs: a caller that skipped getAutopayProvider should die on a
    // TypeError at the exact wrong line, not on a 400 that reads like the customer's fault.
    assert.equal(manual().supportsAutopay, false);
    assert.equal(manual().createSubscription, undefined);
    assert.equal(manual().ensureProviderPlan, undefined);
    assert.equal(manual().cancelProviderSubscription, undefined);
    assert.equal(manual().verifyMandateSignature, undefined);
  });
});

describe('refunds initiated by BillJi', () => {
  const paidPro = async () => {
    clearPlanCache();
    await bootstrapBilling();
    const context = await createTestContext();
    await ensureSubscription({ business: context.business });

    const pro = await Plan.findOne({ key: 'pro' });
    const subscription = await applyPlan({ business: context.business, plan: pro, interval: 'year', amount: 199900 });
    const payment = await SubscriptionPayment.create({
      business: context.business._id,
      subscription: subscription._id,
      provider: 'razorpay',
      status: 'captured',
      amount: 199900,
      netAmount: 199900,
      planKey: 'pro',
      billingInterval: 'year',
      periodStart: subscription.currentPeriodStart,
      periodEnd: subscription.currentPeriodEnd,
      providerRefs: { orderId: 'order_TEST1', paymentId: 'pay_TEST1' }
    });

    return { ...context, payment, subscription };
  };

  it('calls the provider and ends access on a full refund', async () => {
    const { business, payment } = await paidPro();
    const { payment: refunded } = await refundPayment({ payment, reason: 'goodwill' });

    assert.equal(refunded.status, 'refunded');
    assert.equal(refunded.refundedAmount, 199900);
    assert.ok(razorpay.calls.some((call) => call.path.endsWith('/refund')));

    const subscription = await Subscription.findOne({ business: business._id });
    assert.equal(resolveStatus(subscription), 'cancelled', 'a refund that leaves the plan running is a free plan');
  });

  it('leaves access intact on a partial refund', async () => {
    const { business, payment } = await paidPro();
    const { payment: refunded } = await refundPayment({ payment, amount: 50000 });

    assert.equal(refunded.status, 'partially_refunded');
    assert.equal(refunded.refundedAmount, 50000);
    assert.equal(resolveStatus(await Subscription.findOne({ business: business._id })), 'active');
  });

  it('refuses to refund more than is left', async () => {
    const { payment } = await paidPro();
    await refundPayment({ payment, amount: 150000 });

    const partial = await SubscriptionPayment.findById(payment._id);
    await assert.rejects(refundPayment({ payment: partial, amount: 100000 }), /exceeds what is left/);
  });

  it('refuses to refund a payment that was never captured', async () => {
    const { payment } = await paidPro();
    payment.status = 'created';
    await payment.save();

    await assert.rejects(refundPayment({ payment }), /Only a captured payment/);
  });

  it('does not revoke a newer period when an older payment is refunded', async () => {
    const { business, payment } = await paidPro();
    // The customer has since renewed, so currentPeriodEnd no longer matches this payment.
    await Subscription.updateOne({ business: business._id }, { $set: { currentPeriodEnd: new Date(Date.now() + 700 * DAY) } });

    await refundPayment({ payment });

    const subscription = await Subscription.findOne({ business: business._id });
    assert.equal(subscription.cancel.effectiveAt, null, 'refunding an old payment must not revoke a later paid period');
  });
});

describe('proration credit', () => {
  const now = new Date('2026-06-15T00:00:00.000Z');

  it('credits the unused half of a period', () => {
    const credit = prorationCredit({
      subscription: {
        status: 'active',
        currentPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-07-01T00:00:00.000Z'),
        pricing: { amount: 30000 },
        trial: {},
        cancel: {}
      },
      now
    });
    // 16 of 30 days remain.
    assert.equal(credit, 16000);
  });

  it('credits nothing for a free plan, an expired period, or a plan that never expires', () => {
    const base = { status: 'active', trial: {}, cancel: {} };
    assert.equal(prorationCredit({ subscription: { ...base, pricing: { amount: 0 }, currentPeriodStart: now, currentPeriodEnd: new Date('2026-07-01') }, now }), 0);
    assert.equal(prorationCredit({ subscription: { ...base, pricing: { amount: 30000 }, currentPeriodStart: new Date('2026-05-01'), currentPeriodEnd: new Date('2026-06-01') }, now }), 0);
    assert.equal(prorationCredit({ subscription: { ...base, pricing: { amount: 30000 }, currentPeriodStart: now, currentPeriodEnd: null }, now }), 0);
  });

  it('never credits more than was paid', () => {
    const credit = prorationCredit({
      subscription: {
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: new Date('2027-06-15T00:00:00.000Z'),
        pricing: { amount: 199900 },
        trial: {},
        cancel: {}
      },
      now
    });
    assert.ok(credit <= 199900);
  });
});

describe('receipt numbering', () => {
  it('starts at one and stays continuous within a financial year', async () => {
    const { business } = await createTestContext();
    const april = new Date('2026-04-10T00:00:00.000Z');

    const first = await nextReceiptNumber(april);
    assert.equal(first, 'BILLJI/2026-27/000001');

    await SubscriptionPayment.create({
      business: business._id,
      provider: 'manual',
      planKey: 'pro',
      receipt: { number: first }
    });

    assert.equal(await nextReceiptNumber(april), 'BILLJI/2026-27/000002');
  });

  it('rolls the series on the Indian financial year, not the calendar year', async () => {
    assert.match(await nextReceiptNumber(new Date('2026-03-31T00:00:00.000Z')), /^BILLJI\/2025-26\//);
    assert.match(await nextReceiptNumber(new Date('2026-04-01T00:00:00.000Z')), /^BILLJI\/2026-27\//);
  });
});
