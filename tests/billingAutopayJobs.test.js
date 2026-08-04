import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import AuditLog from '../src/models/AuditLog.js';
import Notification from '../src/models/Notification.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import { bootstrapBilling } from '../src/bootstrap/billing.js';
import {
  reconcileAutopayMandates,
  runBillingReconciliation,
  sendAutopayDebitNotices,
  sendRenewalReminders
} from '../src/services/billingReconciliation.js';
import { clearPlanCache } from '../src/services/entitlementService.js';
import { applyPlan } from '../src/services/subscriptionService.js';
import { useMongoTestDb } from './helpers/db.js';
import { createTestContext } from './helpers/fixtures.js';
import { configureRazorpay, stubRazorpay, unconfigureRazorpay } from './helpers/razorpayStub.js';

// THE AUTOPAY SAFETY NETS.
//
// Two jobs and one behaviour change:
//   - renewal reminders must SKIP a working mandate (the existing copy says "nothing is charged
//     automatically", which for those customers is both alarming and false) and must still fire the
//     moment that mandate stops working;
//   - an upcoming debit is announced once per cycle;
//   - a mandate the provider still calls live but which has stopped charging us is a customer who may
//     have paid for nothing. Alert, never silently grant.

useMongoTestDb();

const DAY_MS = 24 * 60 * 60 * 1000;
let razorpay;

beforeEach(() => {
  configureRazorpay();
  razorpay = stubRazorpay();
});

afterEach(() => {
  razorpay.restore();
  unconfigureRazorpay();
});

/** A Pro subscriber whose period ends in `days`, with the autopay mirror set to `autopay`. */
const subscriber = async ({ days = 2, autopay = null } = {}) => {
  clearPlanCache();
  await bootstrapBilling();
  const context = await createTestContext();
  const plan = await Plan.findOne({ key: 'pro' });
  await applyPlan({ business: context.business._id, plan, interval: 'month', action: 'activated', amount: 24900 });

  const periodEnd = new Date(Date.now() + days * DAY_MS);
  await Subscription.updateOne(
    { business: context.business._id },
    {
      $set: {
        currentPeriodEnd: periodEnd,
        graceEndsAt: new Date(periodEnd.getTime() + 7 * DAY_MS),
        ...(autopay
          ? {
              'provider.name': 'razorpay',
              'provider.subscriptionId': 'sub_TEST1',
              'autopay.planKey': 'pro',
              'autopay.interval': 'month',
              'autopay.chargeAmount': 24900,
              ...Object.fromEntries(Object.entries(autopay).map(([key, value]) => [`autopay.${key}`, value]))
            }
          : {})
      }
    }
  );

  return context;
};

const notificationsFor = (business, type) => Notification.find({ business: business._id, type });

describe('renewal reminders and autopay', () => {
  it('says nothing to a subscriber whose mandate is working', async () => {
    const { business } = await subscriber({ days: 2, autopay: { enabled: true, status: 'active' } });

    const result = await sendRenewalReminders();

    assert.equal(result.sent, 0);
    // The existing copy promises "Nothing is charged automatically" — true for manual, false here.
    assert.equal((await notificationsFor(business, 'subscription-renewal')).length, 0);
  });

  it('still warns a manual subscriber, with the existing copy intact', async () => {
    const { business } = await subscriber({ days: 2 });

    const result = await sendRenewalReminders();

    assert.equal(result.sent, 1);
    const [notification] = await notificationsFor(business, 'subscription-renewal');
    assert.match(notification.description, /Nothing is charged automatically/);
  });

  it('warns again the moment a mandate stops working', async () => {
    // Every failure state clears `enabled`, so those subscribers fall back into the manual reminder —
    // where that copy is true again. This is why the job skips rather than rewriting the wording.
    for (const status of ['halted', 'cancelled', 'completed']) {
      const { business } = await subscriber({ days: 2, autopay: { enabled: false, status } });

      const result = await sendRenewalReminders();

      assert.equal(result.sent, 1, `expected a reminder for a ${status} mandate`);
      assert.equal((await notificationsFor(business, 'subscription-renewal')).length, 1);
      await Notification.deleteMany({});
      await Subscription.deleteMany({});
    }
  });
});

describe('upcoming debit notices', () => {
  it('announces the next debit once, however often the sweep runs', async () => {
    const nextDebitAt = new Date(Date.now() + 2 * DAY_MS);
    const { business } = await subscriber({ days: 2, autopay: { enabled: true, status: 'active', nextDebitAt } });

    const first = await sendAutopayDebitNotices();
    const second = await sendAutopayDebitNotices();

    assert.equal(first.sent, 1);
    assert.equal(second.sent, 1, 'the upsert re-writes the same row rather than skipping it');
    const rows = await notificationsFor(business, 'autopay-debit-upcoming');
    assert.equal(rows.length, 1, 'one notification per cycle, keyed on the debit instant');
    assert.match(rows[0].title, /renews on/);
  });

  it('mints a new notice for the next cycle', async () => {
    const { business } = await subscriber({
      days: 2,
      autopay: { enabled: true, status: 'active', nextDebitAt: new Date(Date.now() + 2 * DAY_MS) }
    });
    await sendAutopayDebitNotices();

    // A month later the debit instant differs, so it is a new row rather than a resolved one reused.
    await Subscription.updateOne(
      { business: business._id },
      { $set: { 'autopay.nextDebitAt': new Date(Date.now() + 32 * DAY_MS), currentPeriodEnd: new Date(Date.now() + 32 * DAY_MS) } }
    );
    await sendAutopayDebitNotices({ now: new Date(Date.now() + 30 * DAY_MS) });

    assert.equal((await notificationsFor(business, 'autopay-debit-upcoming')).length, 2);
  });

  it('says nothing about a debit that is far off, or a mandate that is not active', async () => {
    const { business } = await subscriber({
      days: 40,
      autopay: { enabled: true, status: 'active', nextDebitAt: new Date(Date.now() + 40 * DAY_MS) }
    });
    assert.equal((await sendAutopayDebitNotices()).sent, 0);

    await Subscription.updateOne(
      { business: business._id },
      { $set: { 'autopay.status': 'halted', 'autopay.nextDebitAt': new Date(Date.now() + 1 * DAY_MS) } }
    );
    assert.equal((await sendAutopayDebitNotices()).sent, 0);
  });
});

describe('mandates that stopped charging', () => {
  it('alerts once and re-syncs the clock, rather than re-alerting every hour', async () => {
    const { business } = await subscriber({
      days: 5,
      autopay: { enabled: true, status: 'active', nextDebitAt: new Date(Date.now() - 5 * DAY_MS) }
    });
    // The provider still says the mandate is live and has charged more times than we have seen.
    razorpay.state.remoteSubscription = {
      status: 'active',
      paid_count: 4,
      charge_at: Math.floor((Date.now() + 25 * DAY_MS) / 1000)
    };

    const first = await reconcileAutopayMandates();

    assert.equal(first.alerted, 1);
    const alerts = await AuditLog.find({ business: business._id, action: 'billing.autopay.charge_missing' });
    assert.equal(alerts.length, 1);
    // A period is NEVER granted from a status read — only from a charge with a payment id.
    const subscription = await Subscription.findOne({ business: business._id });
    assert.ok(subscription.autopay.nextDebitAt > new Date(), 'the clock must be refreshed so this stops re-firing');

    const second = await reconcileAutopayMandates();
    assert.equal(second.alerted, 0);
  });

  it('mirrors a terminal state whose webhook was lost', async () => {
    const { business } = await subscriber({
      days: 5,
      autopay: { enabled: true, status: 'active', nextDebitAt: new Date(Date.now() - 5 * DAY_MS) }
    });
    razorpay.state.remoteSubscription = { status: 'halted', paid_count: 1 };

    const result = await reconcileAutopayMandates();

    assert.equal(result.mirrored, 1);
    assert.equal(result.alerted, 0, 'a known terminal state is not an ops incident');
    const subscription = await Subscription.findOne({ business: business._id });
    assert.equal(subscription.autopay.enabled, false);
    assert.equal(subscription.autopay.status, 'halted');
    assert.equal(subscription.autopay.nextDebitAt, null);
    // The customer still has to act, so they get the same notice the lost webhook would have raised.
    assert.equal((await notificationsFor(business, 'autopay-halted')).length, 1);
    // ...and the manual renewal reminder takes over as the period approaches.
    assert.equal((await sendRenewalReminders({ now: new Date(Date.now() + 4 * DAY_MS) })).sent, 1);
  });

  it('leaves a mandate alone while the provider is unreachable', async () => {
    const { business } = await subscriber({
      days: 5,
      autopay: { enabled: true, status: 'active', nextDebitAt: new Date(Date.now() - 5 * DAY_MS) }
    });
    razorpay.state.networkDown = true;

    const result = await reconcileAutopayMandates();

    // An outage is not a billing incident: next sweep tries again.
    assert.equal(result.alerted, 0);
    assert.equal(result.mirrored, 0);
    assert.equal((await Subscription.findOne({ business: business._id })).autopay.enabled, true);
  });

  it('ignores a mandate whose debit is still in the future', async () => {
    await subscriber({
      days: 30,
      autopay: { enabled: true, status: 'active', nextDebitAt: new Date(Date.now() + 25 * DAY_MS) }
    });

    const result = await reconcileAutopayMandates();

    assert.equal(result.scanned, 0);
  });
});

describe('the scheduler entry point', () => {
  it('runs every sweep, including the two autopay ones', async () => {
    await subscriber({ days: 2, autopay: { enabled: true, status: 'active', nextDebitAt: new Date(Date.now() + 2 * DAY_MS) } });

    const results = await runBillingReconciliation();

    // Six sweeps: activations, activation failures, renewal reminders, grace reminders, debit notices,
    // mandate reconciliation. A failure in one must not skip the others, hence allSettled.
    assert.equal(results.length, 6);
    assert.equal(results.filter((row) => row.error).length, 0, JSON.stringify(results));
  });
});
