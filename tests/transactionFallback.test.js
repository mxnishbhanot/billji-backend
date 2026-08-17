import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withTransaction } from '../src/utils/transaction.js';
import { useMongoTestDb } from './helpers/db.js';

/**
 * Which environments are allowed to run money operations without transactions.
 *
 * `!isProduction` used to be the rule, which let staging — not production, but the first place
 * concurrency is exercised for real — silently drop to the non-atomic path when pointed at a
 * standalone mongod. Only a developer machine may take that trade now.
 *
 * The "unsupported" answer is cached in the module for the process lifetime, so the test that
 * triggers the fallback runs LAST and nothing after it depends on a session.
 */

useMongoTestDb();

// What a standalone mongod says when a transaction is attempted against it.
const unsupported = () =>
  Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), {
    code: 20,
    codeName: 'IllegalOperation'
  });

const withNodeEnv = async (value, run) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return await run();
  } finally {
    process.env.NODE_ENV = previous;
  }
};

describe('transaction support requirements', () => {
  it('refuses to run without transactions in a deployed environment', async () => {
    for (const nodeEnv of ['staging', 'production', 'preprod']) {
      await withNodeEnv(nodeEnv, async () => {
        await assert.rejects(
          withTransaction(async () => {
            throw unsupported();
          }),
          (error) => {
            assert.match(error.message, /MongoDB transactions are required/);
            assert.match(error.message, new RegExp(nodeEnv));
            // The original driver error is preserved for the logs.
            assert.equal(error.cause?.codeName, 'IllegalOperation');
            return true;
          },
          `expected NODE_ENV=${nodeEnv} to require transactions`
        );
      });
    }
  });

  // Fail closed. A box that simply never had NODE_ENV set must not be treated as a developer
  // machine, and `config/env.js` defaulting `nodeEnv` to 'development' must not reach in here.
  it('refuses to run without transactions when NODE_ENV is unset or empty', async () => {
    for (const nodeEnv of [undefined, '']) {
      const previous = process.env.NODE_ENV;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;

      try {
        await assert.rejects(
          withTransaction(async () => {
            throw unsupported();
          }),
          (error) => {
            assert.match(error.message, /MongoDB transactions are required/);
            assert.equal(error.cause?.codeName, 'IllegalOperation');
            return true;
          },
          `expected NODE_ENV=${JSON.stringify(nodeEnv)} to require transactions`
        );
      } finally {
        process.env.NODE_ENV = previous;
      }
    }
  });

  it('rethrows an unrelated failure untouched', async () => {
    await withNodeEnv('staging', async () => {
      await assert.rejects(
        withTransaction(async () => {
          throw new Error('something else went wrong');
        }),
        /something else went wrong/
      );
    });
  });

  // Runs last: it caches "transactions unsupported" for the rest of this process.
  it('still falls back to no session on a developer machine', async () => {
    await withNodeEnv('development', async () => {
      const sessions = [];
      const result = await withTransaction(async (session) => {
        sessions.push(session);
        if (sessions.length === 1) throw unsupported();
        return 'ran without a session';
      });

      assert.equal(result, 'ran without a session');
      assert.equal(sessions.length, 2);
      assert.equal(sessions[1], undefined);
    });
  });
});
