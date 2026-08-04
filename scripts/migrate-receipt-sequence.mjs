// Moves subscription receipt numbering onto NumberSequence, and makes the new unique index
// buildable on a database that was written by the old read-max allocator.
//
// WHY THIS IS REQUIRED, not optional: the old allocator read the highest existing receipt number and
// added one, so two concurrent checkouts could receive the SAME number. If any such pair exists, the
// unique partial index on `receipt.number` will refuse to build and the deploy leaves the collection
// without the guard.
//
// What it does, in order:
//   1. Reports (and with --fix, renumbers) duplicate receipt numbers, keeping the oldest row's number
//      and re-issuing to the newer ones from the top of the series.
//   2. Seeds the NumberSequence counter per financial year to the highest number already issued, so
//      the first receipt after the deploy continues the series instead of restarting at 000001.
//
// Idempotent: safe to run repeatedly. Read-only unless --fix is passed.
//
//   node scripts/migrate-receipt-sequence.mjs            # report only
//   node scripts/migrate-receipt-sequence.mjs --fix      # renumber duplicates + seed the sequence
import mongoose from 'mongoose';
import { PLATFORM_SCOPE_ID } from '../src/services/numberingService.js';
import { RECEIPT_PREFIX, RECEIPT_SEQUENCE_TYPE } from '../src/services/billingService.js';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/quickinvoice';
const apply = process.argv.includes('--fix');

const parse = (number) => {
  const match = /^([A-Z]+)\/(\d{4}-\d{2})\/(\d+)$/.exec(String(number || ''));
  return match ? { prefix: match[1], financialYear: match[2], sequence: Number(match[3]) } : null;
};

const format = (financialYear, sequence) => `${RECEIPT_PREFIX}/${financialYear}/${String(sequence).padStart(6, '0')}`;

await mongoose.connect(uri);
const db = mongoose.connection.db;
const payments = db.collection('subscriptionpayments');
const sequences = db.collection('numbersequences');

const rows = await payments
  .find({ 'receipt.number': { $gt: '' } }, { projection: { 'receipt.number': 1, createdAt: 1 } })
  .sort({ createdAt: 1 })
  .toArray();

console.log(`${rows.length} payment(s) carry a receipt number.`);

// --- 1. duplicates -------------------------------------------------------------------
const byNumber = new Map();
for (const row of rows) {
  const number = row.receipt.number;
  if (!byNumber.has(number)) byNumber.set(number, []);
  byNumber.get(number).push(row);
}

// Highest sequence per financial year — where re-issued numbers come from.
const highest = new Map();
for (const number of byNumber.keys()) {
  const parsed = parse(number);
  if (!parsed) continue;
  highest.set(parsed.financialYear, Math.max(highest.get(parsed.financialYear) || 0, parsed.sequence));
}

const duplicates = [...byNumber.entries()].filter(([, group]) => group.length > 1);

if (!duplicates.length) {
  console.log('No duplicate receipt numbers. The unique index will build cleanly.');
} else {
  console.log(`\n${duplicates.length} duplicated receipt number(s):`);
  for (const [number, group] of duplicates) {
    const parsed = parse(number);
    // Oldest keeps the number; every later row is re-issued from the top of that year's series.
    for (const row of group.slice(1)) {
      const financialYear = parsed?.financialYear;
      if (!financialYear) {
        console.log(`  ${number} — UNPARSEABLE, fix by hand (payment ${row._id})`);
        continue;
      }

      const next = (highest.get(financialYear) || 0) + 1;
      highest.set(financialYear, next);
      const replacement = format(financialYear, next);

      console.log(`  ${number} -> ${replacement} (payment ${row._id})`);
      if (apply) await payments.updateOne({ _id: row._id }, { $set: { 'receipt.number': replacement } });
    }
  }
}

// --- 2. seed the sequence ------------------------------------------------------------
console.log('');
for (const [financialYear, current] of highest) {
  const existing = await sequences.findOne({
    business: PLATFORM_SCOPE_ID,
    documentType: RECEIPT_SEQUENCE_TYPE,
    financialYear
  });

  // Never move a counter backwards: that would re-issue numbers already on a customer's receipt.
  if (existing && existing.current >= current) {
    console.log(`${financialYear}: sequence already at ${existing.current} (>= ${current}), left alone.`);
    continue;
  }

  console.log(`${financialYear}: seeding sequence to ${current}${apply ? '' : ' (dry run)'}`);
  if (apply) {
    await sequences.updateOne(
      { business: PLATFORM_SCOPE_ID, documentType: RECEIPT_SEQUENCE_TYPE, financialYear },
      {
        $set: { prefix: RECEIPT_PREFIX, current, updatedAt: new Date() },
        $setOnInsert: {
          business: PLATFORM_SCOPE_ID,
          documentType: RECEIPT_SEQUENCE_TYPE,
          financialYear,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );
  }
}

if (!apply) console.log('\nDry run. Re-run with --fix to apply.');
await mongoose.disconnect();
