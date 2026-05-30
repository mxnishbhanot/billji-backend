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
