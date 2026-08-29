// Wipes a development database and rebuilds every schema index from the models.
//
// Use this instead of the one-off migrations in this directory when you want a clean
// slate: those scripts exist to repair data written by an older schema, and on an empty
// database every one of them is a no-op. Drop, re-index, seed — no migration needed.
//
//   node scripts/reset-dev-db.mjs           # drop + create indexes
//   npm run db:reset                        # the above, then npm run seed
//
// Refuses to run against a database whose name does not end in -dev or -test unless
// --force is passed, because the only mistake this script can make is unrecoverable.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';

const uri = env.mongoUri || process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is required');

await mongoose.connect(uri);
const db = mongoose.connection.db;

// Guard on the name the driver actually resolved, not on parsing the URI: a seed-list
// connection string (host,host,host) is not a valid URL and cannot be parsed.
if (!/-(dev|test)$/.test(db.databaseName) && !process.argv.includes('--force')) {
  console.error(`refusing to wipe "${db.databaseName}" — name does not end in -dev or -test. Pass --force if you mean it.`);
  await mongoose.disconnect();
  process.exit(1);
}

const before = await db.listCollections().toArray();
console.log(`dropping ${before.length} collection(s) from ${db.databaseName}`);
await db.dropDatabase();

// Import every model so Mongoose knows the full schema set, then build the indexes
// explicitly rather than relying on the API's autoIndex at next boot.
const modelsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/models');
for (const file of readdirSync(modelsDir).filter((name) => name.endsWith('.js')).sort()) {
  await import(path.join(modelsDir, file));
}
for (const name of mongoose.modelNames().sort()) {
  await mongoose.model(name).createIndexes();
}
console.log(`indexes built for ${mongoose.modelNames().length} model(s)`);

await mongoose.disconnect();
console.log('done — run `npm run seed` to populate demo data');
