import { runReminderMaterialization } from '../services/reminderService.js';
import { registerJob } from '../services/scheduler.js';

const HOUR_MS = 60 * 60 * 1000;

// Every scheduled job in one place, so what runs on a clock is readable at a glance.
export const registerScheduledJobs = () => {
  registerJob({
    key: 'reminders:materialize',
    everyMs: HOUR_MS,
    run: () => runReminderMaterialization()
  });
};
