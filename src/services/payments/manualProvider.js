import crypto from 'crypto';
import { ApiError } from '../../utils/ApiError.js';

// Bank transfer, UPI collect, enterprise invoice: money that arrives outside any gateway.
//
// This exists in Phase 3 rather than "later" for one reason — an abstraction with a single
// implementation is not an abstraction, it is a guess. Thirty lines here prove the seam is real,
// and Enterprise ("custom pricing", NEFT against an invoice) genuinely needs it.
//
// Flow: createOrder mints a reference the customer quotes on the transfer, the payment sits
// `created`, and a platform admin marks it captured once the money lands (P6 admin API). Nothing
// is verified client-side because there is nothing to verify — no gateway signed anything.

export const manualProvider = {
  name: 'manual',

  // There is no mandate to hold: a bank transfer cannot debit itself. `getAutopayProvider` refuses
  // on this flag, and the five autopay methods are LEFT UNDEFINED on purpose — a caller that
  // skipped the gate should die on a TypeError at the exact wrong line, not on a
  // PROVIDER_UNSUPPORTED 400 that reads like the customer did something wrong.
  supportsAutopay: false,

  isConfigured: () => true,

  publicConfig: () => ({}),

  createOrder: async ({ amount, currency = 'INR', receipt }) => ({
    providerOrderId: `manual_${crypto.randomUUID()}`,
    amount,
    currency,
    // Surfaced to the customer as the transfer reference, so ops can match a bank line to a row.
    raw: { manual: true, receipt, instructions: 'Quote this reference on the transfer' }
  }),

  /**
   * Always false, and deliberately not "true because there's no gateway": a manual payment must be
   * confirmed by a human who has seen the money, never by the client claiming it paid.
   */
  verifyPaymentSignature: () => false,

  fetchPayment: async () => {
    throw new ApiError(400, 'A manual payment has no provider record to fetch', { code: 'PROVIDER_UNSUPPORTED' });
  },

  refund: async ({ amount = null }) => ({
    // Recorded, not executed — someone reverses the transfer by hand.
    refundId: `manual_refund_${crypto.randomUUID()}`,
    amount,
    status: 'processed',
    raw: { manual: true, note: 'Refund recorded in BillJi; reverse the transfer manually' }
  }),

  parseWebhook: () => {
    throw new ApiError(400, 'The manual provider has no webhooks', { code: 'PROVIDER_UNSUPPORTED' });
  }
};

export default manualProvider;
