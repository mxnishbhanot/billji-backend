import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ScheduledJobRun from '../src/models/ScheduledJobRun.js';
import { claimJob, registerJob, runDueJobs } from '../src/services/scheduler.js';
import { useMongoTestDb } from './helpers/db.js';

useMongoTestDb();

const HOUR_MS = 60 * 60 * 1000;

describe('scheduler job claiming', () => {
  it('claims a never-run job once, then refuses until the window elapses', async () => {
    const now = new Date();

    assert.equal(await claimJob('demo:first', HOUR_MS, now), true);
    // Second instance ticking in the same window loses the race.
    assert.equal(await claimJob('demo:first', HOUR_MS, now), false);

    // Still inside the window an hour later minus a minute.
    assert.equal(await claimJob('demo:first', HOUR_MS, new Date(now.getTime() + HOUR_MS - 60_000)), false);
    // Window elapsed.
    assert.equal(await claimJob('demo:first', HOUR_MS, new Date(now.getTime() + HOUR_MS)), true);

    const row = await ScheduledJobRun.findOne({ key: 'demo:first' }).lean();
    assert.equal(row.runs, 2);
  });

  it('runs a due job exactly once across concurrent ticks', async () => {
    let calls = 0;
    const unregister = registerJob({
      key: 'demo:concurrent',
      everyMs: HOUR_MS,
      run: async () => {
        calls += 1;
      }
    });

    const now = new Date();
    const [first, second] = await Promise.all([runDueJobs(now), runDueJobs(now)]);

    assert.equal(calls, 1);
    assert.equal([...first, ...second].filter((key) => key === 'demo:concurrent').length, 1);
    unregister();
  });

  it('records the error and keeps other jobs running when one fails', async () => {
    let healthyRan = false;
    const unregisterBad = registerJob({
      key: 'demo:failing',
      everyMs: HOUR_MS,
      run: async () => {
        throw new Error('job blew up');
      }
    });
    const unregisterGood = registerJob({
      key: 'demo:healthy',
      everyMs: HOUR_MS,
      run: async () => {
        healthyRan = true;
      }
    });

    const ran = await runDueJobs(new Date());

    assert.equal(healthyRan, true);
    assert.ok(ran.includes('demo:healthy'));
    // A failed job is not reported as run.
    assert.ok(!ran.includes('demo:failing'));

    const failed = await ScheduledJobRun.findOne({ key: 'demo:failing' }).lean();
    assert.match(failed.lastError, /job blew up/);
    const healthy = await ScheduledJobRun.findOne({ key: 'demo:healthy' }).lean();
    assert.equal(healthy.lastError, '');
    assert.ok(healthy.lastFinishedAt);

    unregisterBad();
    unregisterGood();
  });

  it('rejects a job registered without a runnable body or interval', () => {
    assert.throws(() => registerJob({ key: 'demo:bad', everyMs: 0, run: async () => {} }));
    assert.throws(() => registerJob({ key: 'demo:bad', everyMs: HOUR_MS }));
  });
});
