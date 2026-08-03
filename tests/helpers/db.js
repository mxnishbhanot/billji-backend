import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { after, afterEach, before } from 'node:test';

let replSet;

export const useMongoTestDb = () => {
  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret';
    process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret';
    process.env.API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'http://localhost:5000';

    replSet = await MongoMemoryReplSet.create({
      replSet: { storageEngine: 'wiredTiger' },
      binary: { version: '7.0.14' }
    });

    await mongoose.connect(replSet.getUri(), { dbName: `billji_test_${Date.now()}` });

    // Build every index before the first write. Mongoose builds them lazily in the background,
    // so without this a test can insert two rows that a unique index would have refused — and
    // an assertion about uniqueness (a duplicate clientId, a reused invoice number) silently
    // passes against a collection that has no index yet.
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  });

  afterEach(async () => {
    await Promise.all(
      Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({}))
    );
  });

  after(async () => {
    await mongoose.disconnect();
    await replSet?.stop();
    replSet = null;
  });
};
