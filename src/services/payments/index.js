import { ApiError } from '../../utils/ApiError.js';
import manualProvider from './manualProvider.js';
import razorpayProvider from './razorpayProvider.js';

// The provider registry — the ONLY place the rest of the app learns a processor exists.
//
// Providers are code, not database rows: a row cannot implement Stripe. Adding one means writing a
// module with the interface below and listing it here. Nothing in subscriptionService,
// entitlementService or usageService imports a provider, so a new processor changes no business
// logic — which is the requirement that made this a layer instead of a helper.
//
// Interface every provider implements:
//   name                     string
//   isConfigured()            boolean
//   publicConfig()            values safe to send to a client (e.g. a publishable key)
//   createOrder({amount, currency, receipt, notes})  -> {providerOrderId, amount, currency, raw}
//   verifyPaymentSignature({orderId, paymentId, signature}) -> boolean
//   fetchPayment(paymentId)   -> {paymentId, orderId, status, amount, currency, captured, raw}
//   refund({paymentId, amount, notes})              -> {refundId, amount, status, raw}
//   parseWebhook({rawBody, headers})                -> verified event, or throws
//
// Autopay (recurring mandate) additions. Only providers with `supportsAutopay: true` implement
// these; the others must LEAVE THEM UNDEFINED rather than stub them, so a caller that skipped the
// capability gate fails loudly instead of on a swallowed 400:
//   supportsAutopay          boolean
//   ensureProviderPlan({name, amount, currency, interval, intervalCount}) -> {providerPlanId, raw}
//   createSubscription({providerPlanId, totalCount, notes})  -> {providerSubscriptionId, status, customerId, raw}
//   fetchSubscription(providerSubscriptionId)                -> {subscriptionId, status, currentEnd, chargeAt, paidCount, raw}
//   cancelProviderSubscription({providerSubscriptionId, atCycleEnd}) -> {status, raw}
//   verifyMandateSignature({subscriptionId, paymentId, signature}) -> boolean
//
// A provider may own a debit SCHEDULE; it never owns a PERIOD. `createSubscription` buys a mandate
// and a clock — nothing more. BillJi still computes every date it honours in
// subscriptionService.applyPlan, still writes its own payment row per cycle, and still allocates its
// own receipt numbers. subscriptionService imports no provider, and that must stay true.
//
// Not in the interface, deliberately: plans-as-entitlements, periods, trials, grace. A provider
// confirms money moved, and (for autopay) when it intends to move next.

const PROVIDERS = new Map([
  [razorpayProvider.name, razorpayProvider],
  [manualProvider.name, manualProvider]
]);

/** Which processor a self-serve checkout uses when the caller does not say. */
export const DEFAULT_PROVIDER = razorpayProvider.name;

export const getProvider = (name = DEFAULT_PROVIDER) => {
  const provider = PROVIDERS.get(name);
  if (!provider) {
    throw new ApiError(400, `Unknown payment provider: ${name}`, { code: 'PROVIDER_UNKNOWN' });
  }
  if (!provider.isConfigured()) {
    // 503, not 500: the code is fine, the deployment is missing credentials. Refusing here is the
    // point — a half-configured processor must never fall through to a "free" activation.
    throw new ApiError(503, 'Online payments are not available right now', {
      code: 'PROVIDER_NOT_CONFIGURED',
      provider: name
    });
  }
  return provider;
};

/**
 * Same as getProvider, plus the autopay capability check.
 *
 * A separate flag rather than `typeof provider.createSubscription === 'function'`: the flag reads as
 * a decision, duck-typing reads as an accident and would start answering `true` the day someone
 * lands a half-finished method.
 */
export const getAutopayProvider = (name = DEFAULT_PROVIDER) => {
  const provider = getProvider(name);
  if (!provider.supportsAutopay) {
    throw new ApiError(400, 'That payment method cannot set up automatic payments', {
      code: 'PROVIDER_NO_AUTOPAY',
      provider: name
    });
  }
  return provider;
};

/** Providers a client may actually be offered. Powers the checkout method picker later. */
export const availableProviders = () =>
  [...PROVIDERS.values()].filter((provider) => provider.isConfigured()).map((provider) => provider.name);

export const isProviderConfigured = (name) => Boolean(PROVIDERS.get(name)?.isConfigured());
