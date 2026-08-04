import {
  reconcileAutopayMandates,
  reconcileCapturedPayments,
  reportActivationFailures,
  sendAutopayDebitNotices,
  sendGraceReminders,
  sendRenewalReminders
} from '../services/billingReconciliation.js';
import { runReminderMaterialization } from '../services/reminderService.js';
import { registerJob } from '../services/scheduler.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Every scheduled job in one place, so what runs on a clock is readable at a glance.
export const registerScheduledJobs = () => {
  registerJob({
    key: 'reminders:materialize',
    everyMs: HOUR_MS,
    run: () => runReminderMaterialization()
  });

  // Registered separately rather than as one billing job: a customer who paid and has no plan is the
  // most urgent state in the system and must not wait on, or be skipped by, a reminder sweep.
  registerJob({
    key: 'billing:reconcile-activations',
    everyMs: 5 * MINUTE_MS,
    run: () => reconcileCapturedPayments()
  });

  registerJob({
    key: 'billing:activation-failures',
    everyMs: HOUR_MS,
    run: () => reportActivationFailures()
  });

  registerJob({
    key: 'billing:renewal-reminders',
    everyMs: 6 * HOUR_MS,
    run: () => sendRenewalReminders()
  });

  registerJob({
    key: 'billing:grace-reminders',
    everyMs: 6 * HOUR_MS,
    run: () => sendGraceReminders()
  });

  registerJob({
    key: 'billing:autopay-debit-notices',
    everyMs: 6 * HOUR_MS,
    run: () => sendAutopayDebitNotices()
  });

  // Hourly, and its own job for the same reason as activations: a mandate that charged without telling
  // us is a customer who paid and got nothing.
  registerJob({
    key: 'billing:autopay-mandates',
    everyMs: HOUR_MS,
    run: () => reconcileAutopayMandates()
  });
};
