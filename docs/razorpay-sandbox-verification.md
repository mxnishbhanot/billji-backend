# Razorpay sandbox verification runbook

The whole payment integration is stub-tested. Passing tests prove our logic; they prove nothing about
Razorpay's. This is the run that closes that gap. Do it in a sandbox, on a real device, before any
customer sees a checkout.

Nothing here is optional, and nothing here needs Phase 6.

---

## 1. Environment

```
RAZORPAY_KEY_ID=rzp_test_…
RAZORPAY_KEY_SECRET=…
RAZORPAY_WEBHOOK_SECRET=…          # from the dashboard webhook, NOT the API secret
RAZORPAY_API_BASE_URL=https://api.razorpay.com/v1
BILLING_ENFORCEMENT=off
```

The production env guard is all-or-nothing on the three Razorpay vars: a key without a webhook secret
would mean payments activate on the client's word alone, so the server refuses to boot instead.

**The sandbox must not share a webhook secret with production.** A shared secret means staging events
are signed for production, where they arrive as `unmatched` (harmless) — and production events arrive
in staging, where they are not.

## 2. Migrate and preflight

```bash
node scripts/migrate-receipt-sequence.mjs        # report
node scripts/migrate-receipt-sequence.mjs --fix  # renumber duplicates + seed the sequence
node scripts/billing-preflight.mjs               # exits non-zero if anything is missing
```

`migrate-receipt-sequence` must run **before** the deploy that adds the unique index on
`receipt.number`: if the old read-max allocator ever issued a duplicate, the index will not build and
the collection silently ships without the guard. `billing-preflight` is what tells you it did build.

## 3. Webhook

Dashboard → Settings → Webhooks → add:

- URL: `https://<host>/api/v1/billing/webhooks/razorpay`
- Secret: the value of `RAZORPAY_WEBHOOK_SECRET`
- Events, exactly these eleven — anything else is acknowledged and ignored:
  - `payment.captured`
  - `payment.failed`
  - `order.paid`
  - `refund.created`
  - `refund.processed`
  - `subscription.authenticated` — the mandate is live (grants nothing; see §17.2)
  - `subscription.charged` — **THE renewal.** The only autopay event that grants a period
  - `subscription.pending` — a debit failed and will be retried
  - `subscription.halted` — the mandate is dead; the customer must renew by hand
  - `subscription.cancelled`
  - `subscription.completed` — the authorised cycle count ran out

The six `subscription.*` events require **Subscriptions to be enabled on the account**. It is a separate
activation from Orders: a key that happily takes one-time payments still answers `401` on `/plans` and
`/subscriptions`, which surfaces as `PROVIDER_UNAUTHORIZED`. Check that before blaming the code.

Subscribing to both refund events is deliberate and now safe: they are two events for one refund, and
dedup is keyed on the refund id. Before that fix, the pair double-counted the refund and then answered
500 forever.

Confirm the route is still mounted ahead of `express.json()` — the HMAC covers the exact raw bytes.
`tests/billingWebhook.test.js` fails on purpose if that mount regresses.

## 4. The run

On a physical device, against the sandbox. Test card: `4111 1111 1111 1111`, any future expiry, CVV
`123`, OTP `1111`. Also do at least one UPI-intent payment — that is the flow with a real app switch.

| # | Do | Expect |
|---|---|---|
| 1 | Open Plans, tap a paid plan | Checkout WebView opens with our order id and amount |
| 2 | **Double-tap** the plan button | ONE order. Second response carries `resumed: true`, same `orderId` |
| 3 | Pay with the test card | Plan active immediately (client verify), `payment.captured` arrives after |
| 4 | `GET /billing/payments` | One `captured` row, receipt number `BILLJI/<FY>/…`, no provider ids |
| 5 | Replay the capture webhook from the dashboard | `{"duplicate":true}`, period NOT extended |
| 6 | Kill the app mid-payment, then pay | Webhook alone activates. Check the audit log for the actor `webhook` |
| 7 | Pay with a failing card | Payment row `failed`, no plan granted, no crash |
| 8 | Dashboard → refund **half** | `partially_refunded`, `refundedAmount` = half **once**, access intact |
| 9 | Dashboard → refund the rest | `refunded`, subscription cancelled, receipts still readable |
| 10 | Re-deliver both refund events | 200 both times, `refundedAmount` unchanged, no 500 |
| 11 | Upgrade mid-period | Credit on the quote; a second checkout for different terms → 409 `CHECKOUT_ALREADY_OPEN` |
| 12 | Start a trial, then buy | Trial converts, `trial.used` stays true |
| 13 | Restart the API mid-capture (see below) | Reconciliation activates the plan within ~5 min |
| 14 | Set a period end 2 days out | Renewal notification appears once, stage 3 |

### Autopay rows (need Subscriptions enabled)

| # | Do | Expect |
|---|---|---|
| 15 | Open Plans — Autopay is preselected | Explainer names UPI Autopay / card mandate and "cancel any time" |
| 16 | Choose a plan on Autopay | Checkout opens with our `subscription_id`, no order id |
| 17 | Approve with **UPI Autopay** on a physical Android device | The app switch to GPay/PhonePe happens at all (this is what `onShouldStartLoadWithRequest` fixed), and the WebView survives coming back |
| 18 | Mandate approved | Plan active; ONE captured row with a `BILLJI/` receipt; `autopay.status: active` |
| 19 | Background the app mid-mandate | No false "Payment not completed" dialog |
| 20 | Replay `subscription.charged` from the dashboard | `{"duplicate":true}`, period NOT extended |
| 21 | Send a second `subscription.charged` | Period **extends** from the existing end; history `renewed` |
| 22 | Send a charge with a wrong amount | Row `captured` **with** `failureReason`, no period granted, `billing.autopay.amount_unexpected` audited |
| 23 | Turn off autopay | Razorpay reports the subscription `cancelled`; plan and period untouched; renewal reminders resume |
| 24 | Enrol again, then Cancel subscription | Mandate cancelled at Razorpay **and** `cancel.effectiveAt` set. Break the provider cancel on purpose → nothing cancels locally |
| 25 | Refund a full autopay cycle | Mandate cancelled, access ends. Refund an older cycle → mandate keeps running |
| 26 | Card e-mandate, both platforms | AFA/3DS completes inside the WebView |

### Forcing the crash window (13)

The state the reconciliation job exists for: money captured, no subscription.

```js
// mongosh — simulate the interrupted sequence
db.subscriptionpayments.updateOne(
  { _id: ObjectId('<paymentId>') },
  { $set: { status: 'captured', subscription: null, periodEnd: null,
            updatedAt: new Date(Date.now() - 20 * 60 * 1000) } }
);
db.subscriptions.deleteOne({ business: ObjectId('<businessId>') });
```

Within one job window (5 min) the plan is applied and `billing.activation.recovered` appears in the
audit log. Break it further — set `planKey` to something that does not exist — and expect
`billing.activation.recovery_failed` instead, with the money still `captured`. Never rolled back.

## 5. Watch these while you run

```js
db.auditlogs.find({ action: /^billing\./ }).sort({ createdAt: -1 })
```

| Action | Means |
|---|---|
| `billing.activation.recovered` | The safety net worked. Fine, but find out why it was needed |
| `billing.activation.recovery_failed` | **A customer paid and has nothing.** Always a human |
| `billing.activation.needs_review` | Captured, cannot be applied automatically |
| `billing.webhook.amount_mismatch` | Provider amount ≠ our order. Nothing granted |
| `billing.proration.credit_stale` | Two checkouts priced the same unused days |

Server logs: every one of the above also writes to stderr with a `[billing]` prefix.

## 6. Sign-off

The run passes when all fourteen rows behave, the audit log holds no `recovery_failed` or
`amount_mismatch` you cannot explain, and `billing-preflight.mjs` exits 0 against the same database.

Then, and only then, point the same checklist at live keys with `BILLING_ENFORCEMENT=off` and a cohort
you can watch by hand.
