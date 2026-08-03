// Finds businesses whose configured prefixes render document numbers longer than the GST
// 16-character limit (CGST Rule 46(b)), and any document numbers already issued over that
// length. Read-only.
//
// RUN THIS BEFORE DEPLOYING the numbering guard: after the guard ships, an affected
// business cannot create a document until its prefix is shortened. This script tells you
// who to contact first.
//
//   node scripts/audit-document-number-length.mjs
import mongoose from 'mongoose';
import { GST_DOCUMENT_NUMBER_MAX_LENGTH, MAX_DOCUMENT_PREFIX_LENGTH } from '../src/services/numberingService.js';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/quickinvoice';
const PREFIX_FIELDS = ['invoicePrefix', 'quotationPrefix', 'challanPrefix', 'creditNotePrefix', 'purchasePrefix'];

await mongoose.connect(uri);
const db = mongoose.connection.db;

const businesses = await db
  .collection('businesses')
  .find({}, { projection: { businessName: 1, ...Object.fromEntries(PREFIX_FIELDS.map((field) => [field, 1])) } })
  .toArray();

const offenders = businesses
  .map((business) => ({
    business,
    tooLong: PREFIX_FIELDS.filter((field) => (business[field] || '').length > MAX_DOCUMENT_PREFIX_LENGTH)
  }))
  .filter((row) => row.tooLong.length);

console.log(`prefix limit: ${MAX_DOCUMENT_PREFIX_LENGTH} characters (rendered number limit ${GST_DOCUMENT_NUMBER_MAX_LENGTH})`);
console.log(`businesses scanned: ${businesses.length}`);
console.log(`businesses with an over-long prefix: ${offenders.length}`);

for (const { business, tooLong } of offenders) {
  const detail = tooLong.map((field) => `${field}="${business[field]}" (${business[field].length})`).join(', ');
  console.log(`  ${business._id} ${business.businessName}: ${detail}`);
}

// Numbers already in the books. These are historical and are not rewritten — they are
// listed so the compliance exposure is known rather than guessed at.
const issued = await db
  .collection('salesdocuments')
  .aggregate([
    { $match: { $expr: { $gt: [{ $strLenCP: { $ifNull: ['$documentNumber', ''] } }, GST_DOCUMENT_NUMBER_MAX_LENGTH] } } },
    { $group: { _id: '$business', count: { $sum: 1 }, sample: { $first: '$documentNumber' } } },
    { $sort: { count: -1 } }
  ])
  .toArray();

console.log(`\nbusinesses with non-compliant issued numbers: ${issued.length}`);
for (const row of issued) {
  console.log(`  ${row._id}: ${row.count} document(s), e.g. "${row.sample}" (${row.sample.length} chars)`);
}

// A sequence past 9999 in one financial year overflows the format regardless of prefix.
const nearOverflow = await db
  .collection('numbersequences')
  .find({ current: { $gte: 9000 }, financialYear: { $ne: 'ALL' } })
  .toArray();

console.log(`\nsequences approaching the 4-digit ceiling: ${nearOverflow.length}`);
for (const sequence of nearOverflow) {
  console.log(`  ${sequence.business} ${sequence.documentType} ${sequence.financialYear}: ${sequence.current}`);
}

await mongoose.disconnect();
