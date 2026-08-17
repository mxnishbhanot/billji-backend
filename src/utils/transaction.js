import mongoose from 'mongoose';

// Multi-document transactions require a replica set or mongos. A standalone
// mongod (common in local dev and simple self-hosted setups) rejects them with
// "Transaction numbers are only allowed on a replica set member or mongos".
// Deployed environments run on a replica set (MongoDB Atlas) where real transactions
// are used; on a developer machine we fall back to running the work without a session
// so writes still succeed. Detection is cached after the first attempt.
//
// The fallback is deliberately development-only. A replica set can also raise
// IllegalOperation transiently — a node mid-election, a stepdown, a driver that has not
// finished discovering the topology. Caching that answer would silently disable
// atomicity for the rest of the process lifetime, and every ledger write after it would
// be non-atomic with no signal that anything had changed. In a deployed environment a
// transaction that cannot run is an error to surface, not a mode to switch into.
let transactionsSupported = null;

/**
 * Which environments may run without transactions.
 *
 * `!isProduction` was too wide: staging is not production, so a staging box pointed at a
 * standalone mongod would silently drop to the non-atomic path — and staging is exactly where
 * concurrency is first exercised for real. The settlement guards are written to hold without a
 * session, but the ones that depend on multi-document atomicity (compensating ledger entries,
 * balance recomputation) are not, so only a developer machine may take that trade.
 *
 * NODE_ENV is read live rather than through `env.nodeEnv`, following the convention in
 * middlewares/rateLimit.js: the test harness sets it after this module is imported. It is
 * deliberately NOT read through `config/env.js`, which defaults it to 'development' — a
 * configuration-layer default must never be able to switch atomicity off.
 *
 * Fail closed: only an explicit 'development' or 'test' may take the trade. Undefined, empty,
 * 'staging', 'production' or any value nobody anticipated all require real transactions,
 * because the alternative is a box that silently runs money operations non-atomically
 * whenever someone forgets to set the variable.
 */
const TRANSACTIONLESS_ENVIRONMENTS = new Set(['development', 'test']);

const mayRunWithoutTransactions = () => TRANSACTIONLESS_ENVIRONMENTS.has(process.env.NODE_ENV);

const isUnsupportedTransactionError = (error) =>
  error?.code === 20 ||
  error?.codeName === 'IllegalOperation' ||
  /Transaction numbers are only allowed on a replica set member or mongos/i.test(error?.message || '');

export const withTransaction = async (work, options = {}) => {
  if (transactionsSupported === false) {
    return work(undefined);
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
        ...options
      }
    );
    transactionsSupported = true;
    return result;
  } catch (error) {
    if (isUnsupportedTransactionError(error) && mayRunWithoutTransactions()) {
      // The transaction aborts before any write commits, so re-running the
      // work without a session is safe.
      transactionsSupported = false;
      return work(undefined);
    }
    if (isUnsupportedTransactionError(error)) {
      // Name the cause: the deployment is on a standalone mongod, which this environment
      // is not allowed to run money operations against.
      throw new Error(
        `MongoDB transactions are required when NODE_ENV is ${process.env.NODE_ENV === undefined ? 'unset' : `"${process.env.NODE_ENV}"`}. ` +
          'Point this environment at a replica set (or mongos), or run it as NODE_ENV=development.',
        { cause: error }
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }
};
