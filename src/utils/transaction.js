import mongoose from 'mongoose';

// Multi-document transactions require a replica set or mongos. A standalone
// mongod (common in local dev and simple self-hosted setups) rejects them with
// "Transaction numbers are only allowed on a replica set member or mongos".
// Production runs on a replica set (MongoDB Atlas) where real transactions are
// used; everywhere else we fall back to running the work without a session so
// writes still succeed. Detection is cached after the first attempt.
let transactionsSupported = null;

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
    if (isUnsupportedTransactionError(error)) {
      // The transaction aborts before any write commits, so re-running the
      // work without a session is safe.
      transactionsSupported = false;
      return work(undefined);
    }
    throw error;
  } finally {
    await session.endSession();
  }
};
