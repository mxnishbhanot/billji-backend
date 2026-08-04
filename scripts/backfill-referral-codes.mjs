// Mints a referral code for every user who predates the referral feature.
//
// Not strictly required — referralService.ensureReferralCode fills the field in on first read, so a
// user who opens the referral screen gets one either way. This exists so the codes are all in place
// before the feature is announced, and so support can look one up for a user who has not opened the
// app yet.
//
// Idempotent: only touches users with no code, and retries the (rare) unique-index collision.
//
//   node scripts/backfill-referral-codes.mjs [--dry-run]
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import { generateReferralCode } from '../src/utils/referralCode.js';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/quickinvoice';
const dryRun = process.argv.includes('--dry-run');

const run = async () => {
  await mongoose.connect(uri);
  console.log(`[referrals] connected${dryRun ? ' (dry run)' : ''}`);

  const users = await User.find({ $or: [{ referralCode: null }, { referralCode: { $exists: false } }] }).select('_id email');
  console.log(`[referrals] ${users.length} user(s) without a code`);

  let assigned = 0;
  for (const user of users) {
    if (dryRun) continue;

    let done = false;
    for (let attempt = 0; attempt < 5 && !done; attempt += 1) {
      const code = generateReferralCode();
      try {
        const result = await User.updateOne(
          { _id: user._id, $or: [{ referralCode: null }, { referralCode: { $exists: false } }] },
          { $set: { referralCode: code } }
        );
        // Another writer (a live request) got there first. Nothing to do.
        done = true;
        if (result.modifiedCount) assigned += 1;
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }

    if (!done) console.error(`[referrals] could not assign a code to ${user.email}`);
  }

  console.log(`[referrals] assigned ${assigned} code(s)`);
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('[referrals] backfill failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
