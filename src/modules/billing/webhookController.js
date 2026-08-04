import SubscriptionPayment from '../../models/SubscriptionPayment.js';
import { ApiError } from '../../utils/ApiError.js';
import { activateFromPayment, amountMatchesPayment, applyRefund, failPayment } from '../../services/billingService.js';
import { AUTOPAY_EVENTS, handleAutopayEvent } from '../../services/autopayService.js';
import { logAudit } from '../../services/auditService.js';
import { getProvider } from '../../services/payments/index.js';

// Provider webhooks. THE authority on whether money moved — the client verify path exists only so
// the UI does not have to wait for a delivery.
//
// Response policy, which matters as much as the parsing:
//   400  only when the signature is wrong (or the provider is unconfigured). The sender should not
//        retry a forged or unverifiable delivery.
//   200  for everything else, INCLUDING events we do not handle and events we cannot match to a
//        payment. A non-2xx makes Razorpay retry for hours, and retrying will not make an unknown
//        event become known. Unhandled events are logged instead.
//
// Never trust a field in the body over our own record. The event names a payment; the amount,
// plan, period and entitlements all come from the row we created at checkout.

const HANDLED = new Set([
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.created',
  'refund.processed',
  // Autopay mandate lifecycle. Handled in autopayService, which keys off the mandate rather than a
  // payment row.
  ...AUTOPAY_EVENTS
]);

const findPayment = async ({ orderId, paymentId, raw }) => {
  // Order id first: it is the id we wrote at checkout, so it is the strongest link.
  if (orderId) {
    const byOrder = await SubscriptionPayment.findOne({ 'providerRefs.orderId': orderId });
    if (byOrder) return byOrder;
  }
  if (paymentId) {
    const byPayment = await SubscriptionPayment.findOne({ 'providerRefs.paymentId': paymentId });
    if (byPayment) return byPayment;
  }
  // Last resort: the notes we attached to the order. Covers a payment created against an order we
  // somehow failed to record the id for.
  const noted = raw?.payload?.payment?.entity?.notes?.billjiPaymentId;
  return noted ? SubscriptionPayment.findById(noted).catch(() => null) : null;
};

export const handleProviderWebhook = async (req, res) => {
  let event;
  try {
    event = getProvider(req.params.provider).parseWebhook({ rawBody: req.body, headers: req.headers });
  } catch (error) {
    const status = error instanceof ApiError ? error.statusCode : 400;
    console.error('[billing] rejected webhook:', error.message);
    return res.status(status === 503 ? 503 : 400).json({ success: false, message: error.message });
  }

  if (!HANDLED.has(event.event)) {
    // Subscribed to something we do not act on yet. Acknowledge so the provider stops retrying.
    return res.json({ success: true, ignored: event.event });
  }

  // Autopay branches BEFORE findPayment, and that ordering is load-bearing: a recurring cycle has no
  // payment row until its own charge event creates one, so findPayment would answer `unmatched` and
  // silently drop a renewal. Everything below this line is untouched by autopay, which is what keeps
  // manual purchases behaving exactly as they did.
  if (event.event.startsWith('subscription.')) {
    try {
      return await handleAutopayEvent({ event, res });
    } catch (error) {
      console.error(`[billing] failed to apply ${event.event} (${event.eventId}):`, error.message);
      return res.status(500).json({ success: false, message: 'Could not process the event' });
    }
  }

  const payment = await findPayment(event);
  if (!payment) {
    // A genuine, signed event we cannot tie to a checkout — a dashboard-created payment, or a
    // stale event from another environment sharing the webhook secret. Log loudly, do not retry.
    console.error(`[billing] webhook ${event.event} has no matching payment (order=${event.orderId} payment=${event.paymentId})`);
    return res.json({ success: true, unmatched: true });
  }

  // One atomic dedup for every event type: if this id was already applied, nothing happens.
  if (payment.webhookEventIds?.includes(event.eventId)) {
    return res.json({ success: true, duplicate: true });
  }

  // What the provider says was paid must be what we asked for, on this path too — the client verify
  // path has always checked it. An order fixes its amount, so a mismatch is not a rounding
  // difference: it is a partial capture, a dashboard-edited payment or an event from another
  // environment. Grant nothing, flag the row, and acknowledge — retrying cannot make the amounts
  // agree, so a 5xx would only produce hours of pointless redelivery.
  if (['payment.captured', 'order.paid'].includes(event.event) && !amountMatchesPayment(payment, event.amount)) {
    console.error(
      `[billing] webhook ${event.event} amount ${event.amount} does not match payment ${payment._id} (${payment.netAmount})`
    );
    payment.failureReason = `Webhook amount ${event.amount} does not match the order amount ${payment.netAmount}; needs manual review`;
    await payment.save();
    void logAudit(null, {
      business: payment.business,
      action: 'billing.webhook.amount_mismatch',
      resourceType: 'subscription',
      resourceId: String(payment._id),
      metadata: { event: event.event, eventId: event.eventId, expected: payment.netAmount, received: event.amount }
    });

    return res.json({ success: true, amountMismatch: true });
  }

  try {
    switch (event.event) {
      case 'payment.captured':
      case 'order.paid':
        await activateFromPayment({
          payment,
          providerPaymentId: event.paymentId,
          eventId: event.eventId,
          actor: { type: 'webhook', note: event.event }
        });
        break;

      case 'payment.failed':
        await failPayment({ payment, reason: event.failureReason || 'Payment failed at the provider', eventId: event.eventId });
        break;

      case 'refund.created':
      case 'refund.processed':
        await applyRefund({
          payment,
          refundId: event.refundId,
          amount: event.amount ?? payment.netAmount,
          eventId: event.eventId,
          actor: { type: 'webhook', note: event.event }
        });
        break;

      default:
        break;
    }
  } catch (error) {
    // Our own bug or a transient DB failure on a genuine event — this one SHOULD be retried, so it
    // is the only path that returns 5xx.
    console.error(`[billing] failed to apply webhook ${event.event} (${event.eventId}):`, error.message);
    return res.status(500).json({ success: false, message: 'Could not process the event' });
  }

  return res.json({ success: true });
};
