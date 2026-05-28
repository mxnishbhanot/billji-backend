import mongoose from 'mongoose';

export const withTransaction = async (work, options = {}) => {
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
    return result;
  } finally {
    await session.endSession();
  }
};
