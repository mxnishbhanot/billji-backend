import { isUnlimited } from '../services/entitlementService.js';

// THE STABLE BILLING CONTRACT.
//
// Every endpoint that returns the current subscription serialises through subscriptionDto(), so
// mobile has exactly one shape to code against and there is exactly one place to change it.
// GET /billing/subscription, GET /billing/usage and the `subscription` block on every auth
// response all come out of here.
//
// What is deliberately NOT exposed — these are internals, and shipping them would let a client
// couple to things we intend to change:
//   - Mongo internals: __v, timestamps, the raw entitlement Maps
//   - provider metadata: provider name, customerId, subscriptionId, mandateId, order/payment ids
//   - overrides and addOns as separate fields (they are already merged into features/limits;
//     a client must never need to know a value came from an override)
//   - coupon internals, sales notes, pause fields, plan `meta`
//   - engine mechanics: periodKey, limitAtTime, whether a limit is metered or counted live
//
// Rules for changing this file: fields may be ADDED freely. Removing or repurposing one is a
// breaking change for every app build already in users' hands — bump BILLING_CONTRACT_VERSION
// and keep the old field until those builds are gone.

export const BILLING_CONTRACT_VERSION = 1;

const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * One usage row. `limit`/`remaining` are null when there is no ceiling — null means unlimited
 * everywhere in this contract, so a client never has to know about the -1 sentinel.
 */
const usageRowDto = (row) => ({
  key: row.limitKey,
  label: row.label,
  unit: row.unit,
  used: row.used,
  limit: row.unlimited ? null : row.limit,
  remaining: row.unlimited ? null : row.remaining,
  percentUsed: row.percent,
  unlimited: row.unlimited,
  // Non-zero only where usage was accepted past the ceiling (documents created offline). This
  // is what the "you have exceeded your plan" upgrade prompt reads.
  overage: row.overage,
  resetsAt: iso(row.resetsAt)
});

/**
 * The current subscription, as mobile sees it.
 *
 * Date semantics, which are not interchangeable:
 *   renewalDate       when the next payment is due. null when nothing will be charged again
 *                     (free, lifetime, grandfathered) or when a cancellation is pending.
 *   expiryDate        when access actually ends. null when it never does.
 *   gracePeriodEndsAt last instant of continued access after expiryDate. null when no grace.
 *
 * @param {object} access  result of subscriptionService.resolveAccess()
 * @param {Array}  usage   result of usageService.usageSummary()
 * @param {object} plan    the Plan document (for planName), optional
 */
export const subscriptionDto = ({ access, usage = [], plan = null }) => {
  const subscription = access?.subscription || null;
  const cancelPending = Boolean(subscription?.cancel?.effectiveAt);
  const expiryDate = subscription?.cancel?.effectiveAt || subscription?.currentPeriodEnd || null;

  return {
    contractVersion: BILLING_CONTRACT_VERSION,

    planId: access?.planId ? String(access.planId) : null,
    planName: plan?.name || '',
    // Stable identifier for analytics and copy lookups. Never branch on it — features and
    // limits are the authority.
    planKey: access?.planKey || null,
    // Which version of the plan this subscription's entitlements were copied from. Lets support
    // answer "what exactly did this customer buy?" without reading the current plan row.
    snapshotVersion: subscription?.planVersion || null,

    subscriptionStatus: access?.status || 'none',
    billingInterval: subscription?.billingInterval || null,

    renewalDate: cancelPending ? null : iso(subscription?.currentPeriodEnd),
    expiryDate: iso(expiryDate),
    gracePeriodEndsAt: iso(subscription?.graceEndsAt),

    isTrial: Boolean(access?.isTrial),
    trialEndsAt: iso(access?.trialEndsAt),
    inGracePeriod: Boolean(access?.inGrace),
    cancelAtPeriodEnd: cancelPending,

    /**
     * Autopay, in BillJi's own vocabulary — never the provider's, and never any provider id.
     *
     * `status` is a dunning signal, NOT an access signal: `subscriptionStatus` above is still the only
     * thing that says what the business may use. A halted mandate on a paid-up period is
     * `subscriptionStatus: 'active'` with `autopay.status: 'halted'`, and a client must not gate
     * features on the second.
     *
     * `nextDebitAt` is not the same instant as `renewalDate`: the provider debits at (or just before)
     * the cycle end, and the client should show the debit date when autopay is on.
     */
    autopay: {
      enabled: Boolean(subscription?.autopay?.enabled),
      status: subscription?.autopay?.status || 'none',
      nextDebitAt: iso(subscription?.autopay?.nextDebitAt),
      lastChargedAt: iso(subscription?.autopay?.lastChargedAt),
      // What the customer authorised, in paise. This is the figure disclosed at consent, because the
      // mandate ceiling is the plan price — there is no hidden headroom.
      amount: subscription?.autopay?.chargeAmount || null,
      currency: subscription?.autopay?.currency || null
    },

    // The resolved entitlements: snapshot + add-on grants + overrides, already merged. This is
    // what the client gates UI on, and what the server re-checks on every request regardless.
    features: { ...(access?.entitlements?.features || {}) },
    limits: publicLimits(access?.entitlements?.limits),

    usageSummary: usage.map(usageRowDto),
    // Flat { key: remaining } for cheap lookups. null = unlimited.
    remainingLimits: Object.fromEntries(usage.map((row) => [row.limitKey, row.unlimited ? null : row.remaining]))
  };
};

/**
 * One row of payment history.
 *
 * Amounts in integer paise, same as everywhere else. `providerRefs.signature`, the raw provider
 * payload and internal failure detail are omitted: a client needs to render a receipt line, not to
 * reconcile with Razorpay.
 */
export const paymentDto = (payment) => ({
  id: String(payment._id),
  kind: payment.kind,
  status: payment.status,
  amount: payment.amount,
  discount: payment.discount,
  netAmount: payment.netAmount,
  currency: payment.currency,
  planKey: payment.planKey,
  billingInterval: payment.billingInterval,
  periodStart: iso(payment.periodStart),
  periodEnd: iso(payment.periodEnd),
  couponCode: payment.couponCode || '',
  refundedAmount: payment.refundedAmount || 0,
  refundedAt: iso(payment.refundedAt),
  receiptNumber: payment.receipt?.number || '',
  // Was this cycle taken by a mandate rather than approved by hand? One boolean, derived from the
  // provider ref, so the receipt line can say "Auto-paid" without exposing the mandate id.
  autopay: Boolean(payment.providerRefs?.subscriptionId),
  // Which processor took it, for the customer's own records. No provider ids.
  method: payment.provider,
  // Only while the payment is still standing. Once refunded, `updatedAt` is the refund's timestamp,
  // not the payment's — reporting that as "paid at" would be a wrong date on a receipt.
  paidAt: iso(payment.status === 'captured' ? payment.updatedAt : null),
  createdAt: iso(payment.createdAt)
});

/** Limits with the -1 sentinel translated to null, so clients only ever see one "no ceiling". */
const publicLimits = (limits = {}) =>
  Object.fromEntries(Object.entries(limits || {}).map(([key, value]) => [key, isUnlimited(value) ? null : value]));

/**
 * A plan on the pricing screen. Prices are integer paise — the client formats them; sending a
 * pre-formatted string would bake currency and locale decisions into the API.
 */
export const planDto = (plan, { currentPlanId = null, autopayEnabled = false } = {}) => ({
  planId: String(plan._id),
  planKey: plan.key,
  name: plan.name,
  tagline: plan.tagline || '',
  description: plan.description || '',
  badge: plan.badge || '',
  sortOrder: plan.sortOrder,
  isCurrent: currentPlanId ? String(plan._id) === String(currentPlanId) : false,
  // Enterprise and other private plans carry no self-serve price.
  requiresSalesContact: Boolean(plan.meta?.requiresSalesContact),
  prices: (plan.prices || [])
    .filter((price) => price.status === 'active')
    .map((price) => ({
      interval: price.interval,
      intervalCount: price.intervalCount,
      currency: price.currency,
      amount: price.amount,
      compareAtAmount: price.compareAtAmount || null,
      // Whether this price can be bought on a mandate. Passed in rather than derived here: this
      // module must not import the provider registry, or a serialiser starts depending on deployment
      // configuration. Only monthly/yearly are recurring at the provider.
      autopayAvailable: autopayEnabled && ['month', 'year'].includes(price.interval)
    })),
  features: Object.fromEntries(plan.features || []),
  limits: publicLimits(Object.fromEntries(plan.limits || [])),
  trial: { enabled: Boolean(plan.trial?.enabled), days: plan.trial?.days || 0 }
});
