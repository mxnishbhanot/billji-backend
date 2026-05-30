// One-time migration: drop legacy `user_*` indexes left over from the pre-refactor
// schema (ownership moved from `user` -> `business`/`createdBy`). These stale
// indexes still enforce uniqueness on { user: null, ... }, which collides across
// businesses (e.g. duplicate SKUs / invoice numbers) and breaks seeding.
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/quickinvoice';
await mongoose.connect(uri);
const db = mongoose.connection.db;

const collections = ['products', 'customers', 'invoices'];
let dropped = 0;
for (const name of collections) {
  const col = db.collection(name);
  const indexes = await col.indexes();
  for (const idx of indexes) {
    if (idx.name === '_id_') continue;
    if (JSON.stringify(idx.key).includes('"user"')) {
      await col.dropIndex(idx.name);
      console.log(`dropped ${name}.${idx.name}`);
      dropped += 1;
    }
  }
}
console.log(`done, dropped ${dropped} stale index(es)`);
await mongoose.disconnect();
