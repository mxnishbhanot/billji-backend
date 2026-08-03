// Phase 0 offline-mode migration. Two jobs, in this order:
//
//   1. Backfill `deletedAt: null` and `version: 1` on every syncable collection, so the
//      partial unique indexes below have a field to filter on.
//   2. Swap each business-scoped unique index for one that ignores tombstones, and add
//      the delta-pull cursor and clientId indexes.
//
// Idempotent — safe to re-run. Step 2 drops a unique index before recreating it with the
// new options (MongoDB rejects createIndex on the same key pattern with different
// options), so uniqueness is briefly unenforced on the affected collections. Run it in a
// maintenance window, or accept the window on a collection whose writes you have paused.
//
// Run scripts/audit-document-number-length.mjs BEFORE deploying the code that goes with
// this migration.
//
//   node scripts/phase0-sync-fields.mjs
import mongoose from 'mongoose';
import Customer from '../src/models/Customer.js';
import Expense from '../src/models/Expense.js';
import Order from '../src/models/Order.js';
import Payment from '../src/models/Payment.js';
import Product from '../src/models/Product.js';
import PurchaseBill from '../src/models/PurchaseBill.js';
import SalesDocument from '../src/models/SalesDocument.js';
import Vendor from '../src/models/Vendor.js';

const MODELS = [Product, Customer, SalesDocument, Payment, Expense, Vendor, PurchaseBill, Order];

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/quickinvoice';
const dryRun = process.argv.includes('--dry-run');

// Unique indexes that must be rebuilt with `deletedAt: null` in their filter. Keyed by
// collection, valued by the index names MongoDB derives from the key pattern.
const STALE_UNIQUE_INDEXES = {
  products: ['business_1_sku_1', 'business_1_barcode_1'],
  salesdocuments: ['business_1_documentType_1_documentNumber_1', 'business_1_invoiceNumber_1'],
  purchasebills: ['business_1_billNumber_1'],
  orders: ['business_1_orderNumber_1']
};

const COLLECTIONS = ['products', 'customers', 'salesdocuments', 'payments', 'expenses', 'vendors', 'purchasebills', 'orders'];

await mongoose.connect(uri);
const db = mongoose.connection.db;

console.log(`${dryRun ? '[dry run] ' : ''}connected to ${db.databaseName}`);

// --- 1. backfill -----------------------------------------------------------------
for (const name of COLLECTIONS) {
  const col = db.collection(name);
  const missing = await col.countDocuments({ $or: [{ deletedAt: { $exists: false } }, { version: { $exists: false } }] });

  if (!missing) {
    console.log(`${name}: already backfilled`);
    continue;
  }

  if (dryRun) {
    console.log(`${name}: would backfill ${missing} document(s)`);
    continue;
  }

  const result = await col.updateMany(
    { $or: [{ deletedAt: { $exists: false } }, { version: { $exists: false } }] },
    [
      {
        $set: {
          deletedAt: { $ifNull: ['$deletedAt', null] },
          version: { $ifNull: ['$version', 1] }
        }
      }
    ]
  );
  console.log(`${name}: backfilled ${result.modifiedCount} document(s)`);
}

// --- 2. indexes ------------------------------------------------------------------
for (const [name, staleNames] of Object.entries(STALE_UNIQUE_INDEXES)) {
  const col = db.collection(name);
  const existing = (await col.indexes()).map((index) => index.name);

  for (const indexName of staleNames) {
    if (!existing.includes(indexName)) continue;

    if (dryRun) {
      console.log(`${name}: would drop ${indexName}`);
      continue;
    }

    await col.dropIndex(indexName);
    console.log(`${name}: dropped ${indexName}`);
  }
}

if (dryRun) {
  console.log('[dry run] skipping index creation — run without --dry-run, then restart the API');
} else {
  // The application recreates every schema index on boot via Mongoose autoIndex, but
  // doing it here means the window without a unique index closes now rather than at the
  // next deploy.
  for (const model of MODELS) {
    await model.createIndexes();
    console.log(`${model.collection.collectionName}: indexes synced`);
  }
}

await mongoose.disconnect();
console.log('done');
