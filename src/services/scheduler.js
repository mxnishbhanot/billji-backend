import ScheduledJobRun from '../models/ScheduledJobRun.js';

// Periodic background work. Same shape as the outbox dispatcher (setInterval +
// unref, errors logged not thrown) but claim-based, so the interval can tick on
// every instance while each job body runs once per window across the fleet.
const jobs = new Map();

/**
 * @param {{ key: string, everyMs: number, run: () => Promise<unknown> }} job
 * @returns {() => void} unregister
 */
export const registerJob = ({ key, everyMs, run }) => {
  if (!key || typeof run !== 'function' || !(everyMs > 0)) {
    throw new Error('registerJob requires { key, everyMs > 0, run }');
  }
  jobs.set(key, { key, everyMs, run });
  return () => jobs.delete(key);
};

// The unique index on `key` is what makes the claim safe, and Mongoose builds it
// in the background after model registration. Await it once so an early tick on a
// cold-started instance can't slip two inserts past a not-yet-built index.
let indexesReady = null;
const ensureIndexes = () => {
  indexesReady = indexesReady || ScheduledJobRun.init();
  return indexesReady;
};

/**
 * Atomically claims a job for this instance. Returns false when the job ran
 * recently (by any instance) — the duplicate-key path is the "row exists but is
 * not due yet" case, which upsert surfaces as E11000 rather than a match.
 */
export const claimJob = async (key, everyMs, now = new Date()) => {
  const dueBefore = new Date(now.getTime() - everyMs);
  await ensureIndexes();

  try {
    await ScheduledJobRun.findOneAndUpdate(
      { key, $or: [{ lastRunAt: null }, { lastRunAt: { $lte: dueBefore } }] },
      { $set: { lastRunAt: now }, $setOnInsert: { key }, $inc: { runs: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
};

const finishJob = (key, error) =>
  ScheduledJobRun.updateOne(
    { key },
    { $set: { lastFinishedAt: new Date(), lastError: error ? String(error.message || error).slice(0, 500) : '' } }
  );

/** Runs every registered job whose window has elapsed. Exported for tests. */
export const runDueJobs = async (now = new Date()) => {
  const ran = [];

  for (const job of jobs.values()) {
    let claimed = false;
    try {
      claimed = await claimJob(job.key, job.everyMs, now);
    } catch (error) {
      console.error(`Scheduler could not claim ${job.key}:`, error.message);
      continue;
    }

    if (!claimed) continue;

    try {
      await job.run();
      await finishJob(job.key, null);
      ran.push(job.key);
    } catch (error) {
      // A failing job must not stop the others, and must not crash the tick.
      console.error(`Scheduled job ${job.key} failed:`, error.message);
      await finishJob(job.key, error).catch(() => {});
    }
  }

  return ran;
};

let schedulerTimer = null;

// ponytail: fixed 60s tick — fine while the shortest job window is measured in
// minutes. Move to per-job timers only if a sub-minute job ever appears.
export const startScheduler = ({ intervalMs = 60_000 } = {}) => {
  if (schedulerTimer) return () => {};

  const tick = () => {
    runDueJobs().catch((error) => {
      console.error('Scheduler tick failed:', error.message);
    });
  };

  schedulerTimer = setInterval(tick, intervalMs);
  schedulerTimer.unref?.();

  const immediate = setTimeout(tick, 500);
  immediate.unref?.();

  return () => {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  };
};
