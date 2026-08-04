// Pre-flight for a Razorpay (sandbox or live) validation run. Read-only.
//
// Every check here is something that fails SILENTLY or confusingly at runtime:
//   - a half-configured provider (key without webhook secret) means payments would activate on the
//     client's word alone
//   - a missing unique index turns the engine's "duplicate key means already at the limit" idiom into
//     "everything is allowed", and the receipt guard into nothing
//   - enforcement left on in an unvalidated environment refuses paying customers
//   - no default plan means an expired subscription resolves to nothing
//
//   node scripts/billing-preflight.mjs
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import Plan from '../src/models/Plan.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import SubscriptionUsage from '../src/models/SubscriptionUsage.js';
import { enforcementMode } from '../src/middlewares/entitlement.js';
import { availableProviders } from '../src/services/payments/index.js';

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/quickinvoice';
const results = [];
const check = (ok, label, detail = '') => results.push({ ok, label, detail });

await mongoose.connect(uri);

// --- provider credentials ------------------------------------------------------------
const { keyId, keySecret, webhookSecret, apiBaseUrl } = env.razorpay;
check(Boolean(keyId), 'RAZORPAY_KEY_ID set', keyId ? `${keyId.slice(0, 12)}…` : 'missing');
check(Boolean(keySecret), 'RAZORPAY_KEY_SECRET set');
check(Boolean(webhookSecret), 'RAZORPAY_WEBHOOK_SECRET set');
check(
  webhookSecret !== keySecret,
  'webhook secret differs from the API secret',
  webhookSecret === keySecret ? 'anyone holding the API secret could forge activations' : ''
);
check(
  keyId.startsWith('rzp_test_') || keyId.startsWith('rzp_live_'),
  'key id looks like a Razorpay key',
  keyId.startsWith('rzp_live_') ? 'LIVE key — this is real money' : 'test key'
);
check(apiBaseUrl === 'https://api.razorpay.com/v1', 'API base url is Razorpay', apiBaseUrl);
check(availableProviders().includes('razorpay'), 'razorpay reports itself configured', availableProviders().join(', '));

// --- enforcement ---------------------------------------------------------------------
const mode = enforcementMode();
check(mode === 'off', `BILLING_ENFORCEMENT is off (currently "${mode}")`, mode === 'off' ? '' : 'enforcement is live');

// --- indexes -----------------------------------------------------------------------
// These are load-bearing, not hygiene: three of them are the atomicity of the engine.
const required = [
  [SubscriptionUsage, { business: 1, periodKey: 1, metric: 1 }, 'usage counter uniqueness (the at-ceiling signal)'],
  [SubscriptionPayment, { 'providerRefs.orderId': 1 }, 'one payment per provider order'],
  [SubscriptionPayment, { 'providerRefs.paymentId': 1 }, 'one payment per provider payment'],
  [SubscriptionPayment, { 'receipt.number': 1 }, 'receipt number uniqueness'],
  [Subscription, { business: 1 }, 'one subscription per business']
];

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// listIndexes throws NamespaceNotFound on a collection that has never been written. That is a
// legitimate state (a fresh deploy) and must be REPORTED, not thrown — a preflight that crashes tells
// you nothing about the thing you ran it to check.
const indexesOf = async (model) => {
  try {
    return await model.collection.indexes();
  } catch (error) {
    if (error.codeName === 'NamespaceNotFound' || error.code === 26) return null;
    throw error;
  }
};

for (const [model, key, label] of required) {
  const indexes = await indexesOf(model);
  if (indexes === null) {
    check(false, `unique index: ${label}`, `collection ${model.collection.collectionName} does not exist yet — start the API once, then re-run`);
    continue;
  }

  const found = indexes.find((index) => sameKey(index.key, key));
  check(Boolean(found?.unique), `unique index: ${label}`, found ? (found.unique ? found.name : `${found.name} is NOT unique`) : 'missing');
}

// --- plans ---------------------------------------------------------------------------
const defaults = await Plan.countDocuments({ isDefault: true, status: 'active' });
check(defaults === 1, 'exactly one active default plan', `found ${defaults}`);

const purchasable = await Plan.find({ status: 'active', visibility: 'public' }).lean();
const withPrice = purchasable.filter((plan) => (plan.prices || []).some((price) => price.status === 'active' && price.amount > 0));
check(withPrice.length > 0, 'at least one public plan can be bought', withPrice.map((plan) => plan.key).join(', '));

// --- report ---------------------------------------------------------------------------
const failed = results.filter((row) => !row.ok);
for (const row of results) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.label}${row.detail ? `  — ${row.detail}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);

await mongoose.disconnect();
process.exit(failed.length ? 1 : 0);
