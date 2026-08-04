# BillJi — Subscription, Licensing & Billing Engine · Architecture Reference

> **Status: Phase 0 APPROVED. This document is the official architecture reference.**
> Branch in both repos: `feat/subscription-billing-engine` (off `staging`).
>
> Supersedes the technical section of `../../docs/pricing-plan-v1.md` (different tier
> names/prices, code-config plans, no admin panel). That doc stays useful for pricing
> rationale and India market reasoning only.
>
> **Phases 1-3 are implemented** — catalogs, models, seeders, the snapshot/feature/limit engines
> (§12), the read-only billing API with the stable mobile DTO (§13), and the payment provider
> layer with Razorpay checkout, verification, webhooks and refunds (§14).

---

## 0. Approved decisions (locked — source of truth for every later phase)

| # | Decision | Effect |
|---|---|---|
| 1 | **No auto-renewal in V1.** Manual renewal only. | Razorpay Orders (D9) confirmed. Provider abstraction must leave room for UPI Autopay / card mandates / Stripe recurring later without touching subscription logic. `Subscription.provider.mandateId` reserved. Mandates are **not** implemented. |
| 2 | **Grandfather every existing business into `legacy_pro`.** | Private, ₹0, no expiry, `pricing.locked = true`, snapshot generated, full Pro entitlements. Never silently downgrade an existing user. |
| 3 | **Offline documents are never rejected at sync.** | Sync path counts usage, records overage, triggers an upgrade warning. Interactive online creation still enforces. **Final.** |
| 4 | **Google Play Billing does not block engineering.** | Build the engine; choose the checkout strategy before production release. The provider abstraction stays independent of Play. |
| 5 | **Team members:** Starter 1 · Pro 1 · Business 10 · Enterprise unlimited. | |
| 6 | **Multi-business is a real feature.** `POST /businesses` gets built. | Businesses: Starter 1 · Pro 1 · Business **unlimited** · Enterprise unlimited. Never hardcoded — always read from `subscription.limits`. |
| 7 | **Admin is REST-only.** No admin frontend. | API must fully cover plans, coupons, payments, subscriptions, overrides, usage, metrics. |
| 8 | **Pricing:** Starter ₹0 · Pro ₹249/mo, ₹1,999/yr · Business ₹499/mo, ₹4,999/yr · Enterprise custom. | Stored as integer paise. |

Additionally locked:

- **Feature and limit keys are permanent and immutable**, `snake_case`, e.g. `advanced_reports`.
  Display names are UI-only. Permission checks always use keys.
- **Never hardcode a plan name.** Subscriptions store the plan `_id`; logic reads only
  `planId`, `features` and `limits`. `planKey` exists for filters/analytics and must never
  appear in a branch condition.
- **The usage engine special-cases nothing.** Documents, seats, businesses, exports, imports,
  storage, API calls and AI credits are all just limit keys.
- **Business logic never depends on Razorpay.** BillJi owns subscriptions, plans, limits,
  features, expiry, renewals, grace, trials and usage. Razorpay only processes payments.
- **Entitlements always resolve from the Subscription snapshot**, never from the live Plan.
- **Future compatibility without database redesign** for: build-your-own-plan, add-ons, extra
  businesses, extra team members, extra storage, API access, AI credits, promotional plans,
  lifetime plans. Prepared, not implemented.

---

## 1. Architecture review — what already exists

### 1.1 What we can reuse (do not rebuild)

| Need | Already in repo | Reuse how |
|---|---|---|
| Auth + business scoping | `backend/src/middlewares/auth.js` → `req.user`, `req.business`, `req.membership` | Every billing route rides `protect`; subscription is scoped to `req.business._id` |
| Permission catalog pattern | `constants/permissions.js` (groups → derived map → seeded `Permission` rows → `GET /permissions` → mobile matrix UI) | **Copy this exact pattern for features + limits.** Single catalog file drives guards, seeds, and mobile UI |
| Route guard pattern | `middlewares/authorization.js` `requirePermission(...)` | New `requireFeature(...)` sits next to it, same shape, same error envelope |
| Limit-check abstraction | `services/teamLimitService.js` (`canInvite()` → `{allowed, limit, count}`) | Generalize into `limitService`; team seats become one limit key among many. Its `PLAN_LIMITS` hardcoded map is deleted |
| Per-business plan field | `Business.plan.{key, maxMembers}` | Kept for backward compat, becomes derived/denormalized mirror of `Subscription` |
| Atomic counter pattern | `NumberSequence` + `models/plugins/syncable.js` | Usage counters use the same `findOneAndUpdate` + unique-index idiom |
| Idempotency | `middlewares/idempotency.js` + `IdempotencyKey` (30d retention, request-hash, lock) | Wrap checkout-create; webhook dedup uses its own unique index instead |
| Webhook dedup precedent | `Payment.provider.{provider,providerPaymentId,providerOrderId,providerSignature,webhookEventId}` + sparse indexes | Same field shape on the new `SubscriptionPayment`. **Do not reuse the `Payment` collection** — that is customer→business money; this is business→BillJi money |
| Scheduled jobs | `services/scheduler.js` (claim-based, fleet-safe) + `bootstrap/jobs.js` | Register `billing:dunning`, `billing:expire-trials` here. **No new scheduler** |
| Outbox / events | `OutboxEvent`, `services/eventBus.js`, `eventDispatcher.js` | Emit `subscription.activated`, `subscription.expired` for notifications/analytics |
| Audit trail | `services/auditService.js` `logAudit(req, {...})` + `AuditLog` | Every plan change, admin plan edit, coupon redemption |
| Notifications + push | `notificationService.js`, `pushService.js`, `UserNotificationPreference` | Renewal-due, payment-failed, trial-ending, quota-80% notices |
| Email | `services/emailService.js` (Resend) | Invoice/receipt for subscription payments, dunning mail |
| Mobile API layer | `mobile/src/api/endpoints.ts` (per-domain `*Api` objects), `client.ts` interceptors | Add `billingApi`; intercept `402` centrally in `client.ts` |
| Mobile query keys | `mobile/src/shared/query/queryKeys.ts` | Add `billing.*` keys |
| Mobile gate hook | `mobile/src/shared/hooks/usePermissions.ts` | Mirror as `useEntitlements()` — same fail-open-for-owner reasoning does **not** apply (see §6.6) |
| Mobile settings surface | `SettingsScreen` + `SettingsStack` in `AppNavigator.tsx` | New `Subscription` + `Plans` screens registered in the same stack |
| Bottom-sheet UI pattern | `components/*Sheet.tsx` (30+ existing) | `UpgradeSheet`, `PlanCompareSheet` follow the same file/props shape |
| Toast/dialog convention | `AppToast` (success) / `AppDialog` (errors) | Upgrade success → toast; payment failure → dialog |
| Analytics facade | `mobile/src/services/analytics.ts` | Emit paywall/upgrade/quota events |
| WebView | `react-native-webview` 13.16.1 already a dependency | Razorpay Checkout renders in a WebView — **no new native SDK, no new dependency** |
| Test harness | `node:test` + `mongodb-memory-server` + `supertest`, `tests/*.test.js`, `tests/helpers` | All backend billing tests land here. `tests/planLimit.test.js` already exists and will be extended |

### 1.2 What does NOT exist (contrary to the brief's assumptions)

1. **No Razorpay integration at all.** Zero references in either repo. No `razorpay` dependency. `Payment.provider.*` fields exist but are unused scaffolding. This is greenfield, not an extension.
2. **No billing/monetization code of any kind.** Every user currently gets every feature, unlimited.
3. **No platform-admin concept.** `User` has no `platformRole`/`isAdmin`. RBAC is entirely *within* a business. An admin panel needs a new authorization axis (§4.6).
4. **No admin UI app.** Only `backend` + `mobile` exist. Phase 0 recommendation: admin is **REST-only** for now (curl/Postman/Retool), UI deferred.
5. **No multi-business creation.** `Business.create` happens only at register/Google-signup/seed. The workspace switcher can switch between businesses a user was *invited* to, but an owner cannot create a second business. So "Multi Business" (a Business-tier feature) must be **built**, not just gated.
6. **`teamLimitService` free cap is 2 members**, while the brief says Starter = 1 user. Changing it downgrades every existing user (§7.3).

### 1.3 The one structural trap: the sync push path

`backend/src/modules/sync/registry.js` maps ops (`invoice:create`, `order:create`, …) to
**controller functions directly** (`handler: createInvoice`). Route-level middleware is
**not** executed on the sync path. Any guard implemented only as Express middleware is
bypassed by every offline-created document.

**Therefore:**
- Feature guards for read/report/export endpoints → middleware (those have no sync path).
- Usage-metered creates → guard lives in the **service layer** (or via a new `feature`/`meter`
  field on the sync registry entry, mirroring its existing `permission` field). Both routes
  and sync converge on the same helper.

This is the single highest-risk item in the whole build. It is also why the registry's
existing `permission` + `before` hook fields are the right place to hang the new checks.

---

## 2. Core design decisions

### D1. Entitlements are resolved from a **snapshot on the Subscription**, not from the live Plan

`Subscription.entitlements = { features: {...}, limits: {...} }` is **copied from the Plan
at activation/renewal**. Reads never join to `Plans`.

Why this is the most important decision in the document:
- An admin editing a plan's price/features must not silently mutate what a paying customer
  already bought. Snapshot = correctness.
- Grandfathering, price-locking ("Founding Member ₹1,999 forever"), and per-customer
  enterprise deals all fall out for free — they are just a subscription whose snapshot
  differs from any current plan.
- Zero-join entitlement read: one indexed `Subscription` fetch per request (cacheable).
- "Build Your Own Plan" and add-ons later = a snapshot assembled from parts. **No schema
  change needed**, which is the brief's stated requirement.

Trade-off, stated plainly: fixing a mistake in a plan requires a re-snapshot migration
across affected subscriptions. That is a script, and it is the right cost to pay.

### D2. Plans live in MongoDB, seeded idempotently from a code catalog

Mirrors the existing RBAC bootstrap exactly (`constants/permissions.js` → `bootstrap/rbac.js`
seeds `Permission`/`Role` rows). Admin can edit rows; a fresh DB self-seeds; the catalog file
is diffable in git.

### D3. Feature/limit **keys** are a code catalog; feature/limit **values** are data

`constants/entitlements.js` defines every feature key and limit key with label/unit/group
metadata (exactly like `PERMISSION_GROUPS`). A key must exist in code because code has to
reference it. Values (on/off, numbers) come from the plan/snapshot. `if (plan === 'PRO')`
appears nowhere; `canUseFeature(req, FEATURES.expenses)` appears everywhere.

No `Feature` collection is created. Rows would be pure duplication: a feature key must exist
in code for any code path to check it, so the admin plan editor reads the catalog through
`GET /admin/billing/features`. (Deviation from the original draft — see §12.)

### D4. Limits are **embedded** in plan/snapshot, not a `FeatureLimits` collection

A limit value is meaningless apart from the plan it belongs to, and a separate collection
means a join on the hottest path in the app. Limit *definitions* (key, label, unit, whether
`-1` means unlimited) live in the code catalog alongside features.

### D5. Trial is a **subscription status**, not a `Trials` collection

`status: 'trialing'` + `trialEndsAt` + `trialUsed: true` on the subscription. A trial has no
independent lifecycle, is 1:1 with a subscription, and every query that needs it already has
the subscription in hand. `SubscriptionHistory` records that a trial started/ended.

### D6. Payment providers are a **code registry**, not a collection

A provider needs code to function; a database row cannot make Stripe work. `PROVIDERS` is a
`Map` of `{ createOrder, verifyPayment, parseWebhook, refund }` implementations. Credentials
in `env.js` (same shape as the existing `r2`/`resend` blocks). Enable/disable per environment
is one env var. `Subscription.provider` and `SubscriptionPayment.provider` are plain strings.

### D7. Status is **computed**, not stored-and-cron-corrected

`resolveStatus(subscription, now)` derives `active | in_grace | expired | trialing | cancelled`
from dates on every read. A cron that flips statuses would mean an expired-but-not-yet-visited
subscription grants access until the job runs. Cron exists only for **side effects** (dunning
email, notifications, analytics) — never for correctness.

### D8. Usage period reset needs **no job**

Usage is keyed `{ business, periodKey: 'YYYY-MM', metric }`. A new month is a new document;
that *is* the reset. The brief's "reset automatically every month" is satisfied by not
implementing anything. A retention job (drop docs >13 months) is the only cleanup.

### D9. Razorpay **Orders** (one-time), not Razorpay Subscriptions, for v1

The brief mandates that Razorpay must not own the business logic. Razorpay *Subscriptions*
would put the billing cycle, plan ids, and renewal dates inside Razorpay — the opposite of
the requirement. So: BillJi creates an Order for an amount it computed, verifies the payment
signature, and sets its own `currentPeriodEnd`.

**Consequence that must be accepted explicitly:** without a mandate (UPI Autopay / card
token), there is **no auto-renew**. Renewal = the user pays again after a reminder. Auto-renew
is a Phase 6 addition (`provider.createMandate()` behind the same abstraction). This is a
product decision, not a technical shortcut — flagged in §6.1.

### D10. Subscription is per **Business**, not per User

Matches every existing data-isolation boundary in the codebase (`business: ObjectId` on every
model). A user in two businesses sees two independent plans. Correct for the product and free
to implement.

---

## 3. Database schema

All new files in `backend/src/models/`. All follow existing conventions: ESM default export,
`timestamps: true`, explicit indexes, comments explaining *why*.

### 3.1 `Plan.js` — admin-editable plan catalog

```
key            String, unique, lowercase   // 'starter' | 'pro' | 'business' | 'enterprise' | any future key
name           String                      // 'BillJi Pro'
description    String
tagline        String                      // marketing line
badge          String                      // 'Most Popular' | ''
sortOrder      Number
visibility     'public' | 'private' | 'hidden'   // private = enterprise/custom, not listed
status         'active' | 'archived' | 'disabled'
isDefault      Boolean                     // exactly one: the plan new signups land on
prices: [{                                 // array, so monthly+yearly+lifetime coexist
  interval     'month' | 'year' | 'lifetime' | 'custom'
  intervalCount Number  (default 1)
  currency     String   (default 'INR')
  amount       Number                      // paise (integer) — never floats for money
  compareAtAmount Number                   // strike-through price
  providerRefs { razorpay: String, stripe: String }   // optional provider-side ids
  status       'active' | 'archived'
}]
features       Map<String, Mixed>          // { expenses: true, importExport: true, customTemplates: true }
limits         Map<String, Number>         // { documents_per_month: 200, businesses: 1, team_members: 1 }  (-1 = unlimited)
trial          { enabled: Boolean, days: Number }
grace          { days: Number }            // post-expiry read/write window
meta           Mixed                       // support tier, marketing copy, anything non-behavioural
version        Number                      // bumped on every feature/limit edit; snapshots record it
```

Indexes: `{key:1}` unique · `{status:1, visibility:1, sortOrder:1}`

`Map` type (not fixed sub-schema) is deliberate: adding a feature key must not require a
schema migration. Validation happens against the code catalog at write time, so junk keys
are still rejected.

### 3.2 `Subscription.js` — one live subscription per business

```
business       ObjectId ref Business, unique          // one active subscription per business
plan           ObjectId ref Plan
planKey        String                                  // denormalized for cheap reads/filters
planVersion    Number                                  // which plan version was snapshotted
status         'trialing' | 'active' | 'past_due' | 'in_grace' | 'cancelled' | 'expired' | 'paused'
billingInterval 'month' | 'year' | 'lifetime' | 'free' | 'custom'
entitlements   { features: Map<String,Mixed>, limits: Map<String,Number> }   // ← SNAPSHOT (D1)
currentPeriodStart  Date
currentPeriodEnd    Date | null            // null = free/lifetime, never expires
graceEndsAt         Date | null
trial          { used: Boolean, startedAt: Date, endsAt: Date, planKey: String }
cancel         { requestedAt: Date, effectiveAt: Date, reason: String, atPeriodEnd: Boolean }
pause          { pausedAt: Date, resumesAt: Date }     // schema only, no logic (future-ready)
pricing        { currency, amount, compareAtAmount, locked: Boolean }   // amount actually charged; locked = price-for-life
coupon         { code: String, couponId: ObjectId, discountApplied: Number, appliesUntil: Date }
provider       { name: String, customerId: String, subscriptionId: String, mandateId: String }
addOns         [ { addOnKey, quantity, expiresAt, grants: Mixed } ]   // schema only, no logic (future-ready)
overrides      { features: Map, limits: Map }   // per-customer enterprise deals; applied over the snapshot
notes          String                            // sales/ops notes for enterprise
```

Indexes: `{business:1}` unique · `{status:1, currentPeriodEnd:1}` (dunning scan) ·
`{planKey:1, status:1}` (admin/analytics) · `{'trial.endsAt':1}` sparse

`overrides` is what makes Enterprise ("Custom Pricing / Unlimited Everything") work without
inventing a plan row per customer, and is also the seam that "Build Your Own Plan" and add-ons
will write into later — hence D1's claim of no future schema change.

### 3.3 `SubscriptionUsage.js` — metered counters

```
business    ObjectId ref Business
periodKey   String        // 'YYYY-MM' for monthly metrics, 'all-time' for non-resetting ones
metric      String        // 'documents_per_month' | 'storage_bytes' | 'exports_per_month' | ...
count       Number  default 0
limitAtTime Number        // limit in force when the period opened, for later analysis
lastAt      Date
```

Indexes: `{business:1, periodKey:1, metric:1}` unique (this uniqueness is what makes the
atomic increment safe) · `{periodKey:1}` (retention sweep)

Point-in-time counts (businesses, team_members) are **not** stored here — they are `countDocuments`
against the real collection, which cannot drift. Only *flow* metrics are counters. (`teamLimitService`
already does exactly this; the pattern is proven in-repo.)

### 3.4 `SubscriptionHistory.js` — append-only ledger of plan lifecycle

```
business, subscription, action ('created'|'trial_started'|'trial_ended'|'activated'|'renewed'
  |'upgraded'|'downgraded'|'cancelled'|'expired'|'reactivated'|'grace_entered'|'admin_override')
fromPlanKey, toPlanKey, fromStatus, toStatus
effectiveAt, amount, currency
snapshotBefore, snapshotAfter   // the entitlement snapshots, so any past state is reconstructible
actor { type: 'user'|'system'|'admin'|'webhook', userId, note }
metadata Mixed
```

Index: `{business:1, createdAt:-1}`

Separate from `AuditLog` on purpose: `AuditLog` is per-business user activity shown in the app;
this is billing forensics ("why did this customer lose access on the 3rd?") and revenue reporting.
`logAudit` is *also* called for user-visible actions — the two are complementary, not duplicated.

### 3.5 `SubscriptionPayment.js` — payment history (BillJi's own revenue)

```
business, subscription
kind        'subscription' | 'renewal' | 'upgrade' | 'addon' | 'manual'
provider    'razorpay' | 'stripe' | 'manual' | 'bank_transfer' | 'upi_manual' | 'enterprise_invoice'
status      'created' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded'
amount, currency, tax, discount, netAmount    // all integer paise
planKey, billingInterval, periodStart, periodEnd
couponCode
providerRefs { orderId, paymentId, signature, invoiceId, refundId }
webhookEventId  String        // dedup key
failureReason, refundedAmount, refundedAt
receipt { number, url }
raw         Mixed             // provider payload, for disputes
```

Indexes: `{business:1, createdAt:-1}` · `{'providerRefs.orderId':1}` unique sparse ·
`{'providerRefs.paymentId':1}` unique sparse · `{webhookEventId:1}` unique sparse ·
`{status:1, createdAt:-1}`

**Explicitly a new collection, not the existing `Payment`.** `Payment` records money a
*customer* pays a *business* and feeds `LedgerEntry`, `CustomerBalance`, and GST reports.
Putting BillJi's SaaS revenue in there would corrupt every one of those.

### 3.6 `Coupon.js` + `CouponRedemption.js`

```
Coupon: code (unique, uppercase), description, type ('percent'|'fixed'|'trial_extension'|'free_period'),
  value, currency, appliesTo { planKeys[], intervals[] }, firstTimeOnly, maxRedemptions,
  maxRedemptionsPerBusiness, redemptionCount, validFrom, validUntil, status, durationInPeriods,
  createdBy
CouponRedemption: coupon, code, business, subscription, payment, discountAmount, redeemedAt
```
Indexes: `Coupon {code:1}` unique, `{status:1, validUntil:1}` · `CouponRedemption {coupon:1, business:1}`,
`{business:1}`

`redemptionCount` is incremented with a guarded atomic `$inc` (`redemptionCount < maxRedemptions`)
— same idiom as the usage counter — so a viral coupon cannot be over-redeemed under load.

### 3.7 Add-ons — `Subscription.addOns[]` (**schema only, no routes, no logic**)

```
addOns: [{ addOnKey, name, quantity, status, grants { features: Map, limits: Map }, expiresAt }]
```

Embedded rather than a separate collection (deviation from the original draft, see §12): the
entitlement resolver is the only reader, it already has the subscription in hand, and a
purchased add-on's money lives in `SubscriptionPayment{kind:'addon'}`. `entitlementService`
already merges these grants over the snapshot — numeric grants **add** to the ceiling
(`quantity × value`), so selling extra seats, businesses, storage or AI credits later needs no
migration. Nothing creates an add-on row today.

### 3.8 Modified: `Business.js`

`plan.key` enum is dropped (a fixed enum contradicts admin-created plans) and the block becomes
a read-only denormalized mirror updated by the subscription service:

```
plan: { key: String, subscriptionStatus: String, updatedAt: Date, maxMembers: Number /* deprecated */ }
```

Kept so existing reads (`teamLimitService`, any mobile code) keep working through the transition.
Marked deprecated; `maxMembers` overrides migrate into `Subscription.overrides.limits.team_members`.

### 3.9 Modified: `User.js`

```
platformRole: { type: String, enum: ['none','support','admin'], default: 'none', index: true }
```
The only way to have an admin panel at all. Deliberately a coarse 3-value field rather than a
second RBAC system — one row of code, upgradeable later if support tooling grows.

### 3.10 Not created, and why

| Brief asked for | Decision | Reason |
|---|---|---|
| `Features` collection | Code catalog only (`constants/entitlements.js`) | A key must exist in code for any code path to check it, so DB rows are pure duplication. The admin plan editor reads the catalog over HTTP |
| `FeatureLimits` collection | Embedded in `Plan.limits` / snapshot | See D4 — a join on the hottest read path, for data that is meaningless standalone |
| `Trials` collection | Embedded in `Subscription` | See D5 — 1:1, no independent lifecycle |
| `PaymentProviders` collection | Code registry + env config | See D6 — a row cannot implement a provider |
| `FutureAddOns` | `Subscription.addOns[]` sub-schema, no logic | As instructed: prepare, don't implement. §3.7 |

---

## 4. API design

### 4.1 Customer-facing — `GET/POST /api/v1/billing/*` (new module `modules/billing/`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/billing/plans` | Public plan catalog (active + public), prices, features, limits, current-plan marker |
| GET | `/billing/subscription` | Current subscription: plan, status, resolved entitlements, period/renewal/expiry dates, grace |
| GET | `/billing/usage` | All metrics: `{ metric, used, limit, remaining, resetsAt, percent }[]` |
| POST | `/billing/checkout` | `{ planKey, interval, couponCode? }` → creates `SubscriptionPayment(created)` + provider order → returns `{ orderId, amount, currency, providerKeyId, checkout }`. **Idempotent** |
| POST | `/billing/checkout/verify` | `{ orderId, paymentId, signature }` → verify → activate. Client-confirm path; webhook is the authority |
| POST | `/billing/trial` | Start trial for a plan (once per business, `trial.used` guard) |
| POST | `/billing/coupon/validate` | Dry-run a coupon against a plan+interval; no side effects |
| POST | `/billing/cancel` | `{ atPeriodEnd?: true, reason? }` → access retained to `currentPeriodEnd` |
| POST | `/billing/reactivate` | Undo a not-yet-effective cancellation |
| GET | `/billing/payments` | Paginated `SubscriptionPayment` history |
| GET | `/billing/payments/:id/receipt` | Receipt (PDF via existing `pdfService`) |
| GET | `/billing/enterprise-enquiry` → POST | Enterprise "Contact us" — email to sales, no payment path |

Guards: `protect` + `requirePermission(PERMISSIONS.settingsManage)` for mutations
(`GET` allowed with `settingsView`). A **new** `billing.view` / `billing.manage` permission pair
is added to `PERMISSION_GROUPS` so a business owner can let an accountant see invoices without
letting staff change the plan. Owner/admin roles get both automatically (they hold all permissions).

Upgrade/downgrade are **not** separate endpoints — both are `POST /billing/checkout` with a
different `planKey`. Fewer endpoints, one code path, proration handled in one place.

### 4.2 Webhooks — `POST /api/v1/billing/webhooks/:provider`

- **No `protect`.** Authenticated by HMAC signature over the **raw body**.
- **Mounted before `express.json()`** — see §6.2, this is a real trap in `app.js`.
- Dedups on `webhookEventId` unique index; a duplicate returns `200` without reprocessing.
- Always `200` on a *parseable* signed event (even unhandled types) so the provider stops retrying;
  `400` only on bad signature. Unhandled types are logged.
- Handled Razorpay events: `payment.captured`, `payment.failed`, `order.paid`, `refund.created`,
  `refund.processed`. (Subscription-lifecycle events added only if/when mandates land — D9.)
- Rate-limited separately from `apiLimiter` — a webhook storm must not consume the app's budget.

### 4.3 Enforcement responses

| Case | Status | Code | Body |
|---|---|---|---|
| Feature not in plan | 402 | `FEATURE_NOT_IN_PLAN` | `{ feature, currentPlan, requiredPlans[], upgradeUrl }` |
| Limit reached | 402 | `LIMIT_REACHED` | `{ limit, used, metric, currentPlan, requiredPlans[] }` |
| Subscription expired past grace | 402 | `SUBSCRIPTION_EXPIRED` | `{ expiredAt, graceEndedAt, currentPlan }` |

`402 Payment Required` (not 403) so mobile's client interceptor can distinguish "you need to pay"
from "you lack permission" with zero ambiguity — the existing `403 FORBIDDEN_PERMISSION` envelope
is untouched. `requiredPlans[]` is computed by scanning plans for the cheapest one granting the
feature — never hardcoded.

### 4.4 Read-only extension to existing endpoints

`GET /api/v1/auth/me` and `/auth/login|register|refresh` responses gain a `subscription` block
inside `publicUser()`:

```
subscription: { planKey, planName, status, features, limits, currentPeriodEnd, graceEndsAt,
                trialEndsAt, isTrial, usage: { documents_per_month: {used, limit} } }
```

Purely additive — no existing field changes shape, so old app builds keep working. This is what
lets mobile gate UI offline (the payload is persisted by the existing React Query persister).

### 4.5 Admin — `/api/v1/admin/billing/*` (REST only, no UI this phase)

| Method | Path |
|---|---|
| GET/POST | `/admin/billing/plans` (list incl. archived / create) |
| GET/PATCH | `/admin/billing/plans/:id` (edit price/features/limits → bumps `version`) |
| POST | `/admin/billing/plans/:id/clone` · `/archive` · `/disable` · `/enable` |
| GET | `/admin/billing/subscriptions` (filter: plan, status, expiring, search) |
| GET/PATCH | `/admin/billing/subscriptions/:id` (set overrides, extend period, force status) |
| POST | `/admin/billing/subscriptions/:id/resnapshot` (re-copy plan → snapshot) |
| GET/POST/PATCH | `/admin/billing/coupons` |
| GET | `/admin/billing/payments` (+ `/payments/:id/refund`) |
| GET | `/admin/billing/usage` (aggregate, top consumers) |
| GET | `/admin/billing/features` (catalog for the future plan editor) |
| GET | `/admin/billing/metrics` (MRR, ARR, active by plan, churn, trial conversion) |

Guard: new `middlewares/platformAuth.js` → `requirePlatformAdmin` (`protect` + `user.platformRole === 'admin'`).
Every mutation writes `SubscriptionHistory` + `AuditLog`. Editing a plan **never** touches existing
subscriptions' snapshots (D1) — `/resnapshot` is the explicit, auditable opt-in.

### 4.6 Mobile API surface (`mobile/src/api/endpoints.ts`)

One new `billingApi` object mirroring §4.1 exactly, typed in `mobile/src/types.ts`. No new
HTTP client, no new interceptor stack — one `402` branch added to the existing response
interceptor in `client.ts`.

---

## 5. Files — every change, itemized

### 5.1 Backend — new files

**Catalog + config**
1. `src/constants/entitlements.js` — **the heart of the system.** `FEATURE_GROUPS` (key, label, group,
   description) → derived `FEATURES` map; `LIMIT_DEFINITIONS` (key, label, unit, unlimited sentinel);
   `PLAN_SEEDS` (Starter/Pro/Business/Enterprise as data). Same file shape as `constants/permissions.js`.

**Models (7)**
2. `src/models/Plan.js`
3. `src/models/Subscription.js`
4. `src/models/SubscriptionUsage.js`
5. `src/models/SubscriptionHistory.js`
6. `src/models/SubscriptionPayment.js`
7. `src/models/Coupon.js` (+ `CouponRedemption` in the same file — 1:1 coupled, one import)
   *(add-ons live in `Subscription.addOns[]`, and there is no `Feature` collection — see §3.7 and §12.3)*

**Services**
9. `src/services/subscriptionService.js` — get-or-create, resolve status (D7), snapshot build,
   activate/renew/upgrade/downgrade/cancel/expire, history writes, `Business.plan` mirror sync.
10. `src/services/entitlementService.js` — `canAccessFeature(business, key)`, `featureValue()`,
    `getLimit()`, `resolveEntitlements()` (snapshot + overrides + future add-ons), plan-cache.
11. `src/services/usageService.js` — `checkLimit()`, `incrementUsage()` (guarded atomic),
    `decrementUsage()`, `remainingUsage()`, `usageSummary()`, `periodKeyFor(date)`.
12. `src/services/couponService.js` — validate, price, redeem (guarded atomic), release.
13. `src/services/billingService.js` — price computation, proration, checkout orchestration,
    payment→activation. **The only place that talks to a provider.**
14. `src/services/dunningService.js` — renewal-due / payment-failed / trial-ending / quota-80%
    notifications via the existing notification + email services.

**Payment provider layer**
15. `src/services/payments/index.js` — registry + `getProvider(name)`; throws on unconfigured.
16. `src/services/payments/razorpayProvider.js` — `createOrder`, `verifyPaymentSignature`,
    `parseWebhook`, `refund`, `fetchPayment`.
17. `src/services/payments/manualProvider.js` — bank transfer / UPI manual / enterprise invoice:
    creates a `pending` payment an admin marks captured. Proves the abstraction is real with
    ~30 lines, instead of an interface with one implementation.

**Middleware**
18. `src/middlewares/entitlement.js` — `requireFeature(...keys)`, `requireLimit(metric)`,
    `requireActiveSubscription()`. Same authoring style as `authorization.js`.
19. `src/middlewares/platformAuth.js` — `requirePlatformAdmin`, `requirePlatformSupport`.

**Module + routes**
20. `src/modules/billing/{routes,controller,service}.js` — customer endpoints (§4.1) following the
    `modules/expenses/` three-file convention.
21. `src/modules/billing/webhookRoutes.js` — raw-body webhook route, mounted separately in `app.js`.
22. `src/routes/adminRoutes.js` (+ `src/controllers/adminBillingController.js`) — §4.5.
23. `src/bootstrap/billing.js` — idempotent plan seeding from `PLAN_SEEDS` (mirrors `bootstrap/rbac.js`).
24. `src/migrations/2026-xx-backfill-subscriptions.js` — §7.

### 5.2 Backend — modified files (14)

| File | Change |
|---|---|
| `src/app.js` | Mount `/billing/webhooks` with `express.raw()` **before** `express.json()` (§6.2); separate rate limiter |
| `src/routes/index.js` | `router.use('/billing', billingRoutes)`, `router.use('/admin', adminRoutes)` |
| `src/models/Business.js` | `plan` block → denormalized mirror, enum dropped, `maxMembers` deprecated (§3.8) |
| `src/models/User.js` | `+ platformRole` (§3.9) |
| `src/constants/permissions.js` | New `billing` group: `billing.view`, `billing.manage` |
| `src/middlewares/authorization.js` | Add the two new keys to `ROLE_PERMISSIONS` (owner/admin: both; accountant: view) |
| `src/services/teamLimitService.js` | `PLAN_LIMITS` hardcoded map **deleted**; delegates to `usageService`/`entitlementService`. Public API (`canInvite`) unchanged so `teamController` needs no edit |
| `src/controllers/authController.js` | `publicUser()` + `subscription` block (§4.4); `register`/`googleSignIn` create the default free subscription |
| `src/controllers/invoiceController.js` | Quota check + increment via the shared guard — **inside the controller, not the route**, so the sync path is covered (§1.3) |
| `src/modules/documents/service.js` | Same, for quotation/challan/credit-note/refund-note issue |
| `src/modules/orders/controller.js` | Same, for orders |
| `src/modules/sync/registry.js` | Add optional `feature` + `meter` fields to op entries next to the existing `permission`; `executePush` honours them |
| `src/modules/sync/service.js` | Enforce the new registry fields in `executePush`; overage policy (§6.3) |
| `src/services/invoiceHtml.js` / `pdfService.js` | "Powered by BillJi" footer driven by `features.removeBranding` |
| `src/bootstrap/jobs.js` | Register `billing:dunning` (daily) + `billing:usage-retention` (weekly) |
| `src/config/env.js` | `razorpay: { keyId, keySecret, webhookSecret }` block + production guard |
| `src/seed/index.js` | Seed plans + a subscription for the seeded business |

Premium-route guards added (middleware only — no sync path on these):
`modules/expenses/routes.js`, `modules/purchases/routes.js`, `modules/exports/routes.js`,
`modules/imports/routes.js`, `routes/reportRoutes.js`, `routes/auditRoutes.js`,
`routes/teamRoutes.js`, `routes/roleRoutes.js`, `modules/gst/routes.js` (advanced GST reports).

### 5.3 Mobile — new files (11)

1. `src/shared/hooks/useEntitlements.ts` — `can(feature)`, `limit(key)`, `usage(key)`, `isLocked(feature)`, `plan`. Mirrors `usePermissions.ts`.
2. `src/features/billing/hooks/useSubscription.ts` — React Query wrappers (subscription, plans, usage, payments).
3. `src/features/billing/services/checkoutService.ts` — order → WebView → verify.
4. `src/features/billing/components/RazorpayCheckoutSheet.tsx` — `react-native-webview` hosting Razorpay Checkout; resolves on success/dismiss redirect. **No new dependency.**
5. `src/screens/SubscriptionScreen.tsx` — current plan, status, renewal/expiry, usage bars, upgrade/cancel, payment history.
6. `src/screens/PlansScreen.tsx` — plan comparison, monthly/yearly toggle, current-plan marker, Enterprise → contact.
7. `src/components/UpgradeSheet.tsx` — the §8 locked-feature flow.
8. `src/components/LockedFeatureBadge.tsx` — the lock affordance used everywhere.
9. `src/components/UsageMeter.tsx` — reusable usage bar (dashboard + subscription screen).
10. `src/features/billing/components/PaymentHistoryList.tsx`
11. `src/constants/entitlements.ts` — feature/limit key constants mirroring the backend catalog (same relationship `usePermissions.ts` has to `permissions.js` today).

### 5.4 Mobile — modified files (9)

| File | Change |
|---|---|
| `src/api/endpoints.ts` | `+ billingApi` |
| `src/api/client.ts` | Intercept `402` → surface a typed `PaywallError` carrying `{feature, requiredPlans}` |
| `src/types.ts` | `Subscription`, `Plan`, `UsageSummary`, `SubscriptionPayment` types; `AuthUser.subscription` |
| `src/shared/query/queryKeys.ts` | `billing.{subscription,plans,usage,payments}` |
| `src/store/authStore.ts` | Persist the `subscription` block from `/me` so gating works offline |
| `src/navigation/AppNavigator.tsx` + `params.ts`/`types.ts` | Register `Subscription` + `Plans` in `SettingsStack` (lazy, matching existing style) |
| `src/screens/SettingsScreen.tsx` | "Plan & Billing" row showing current plan + usage |
| `src/screens/DashboardScreen.tsx` | Usage meter at ≥80% + upgrade CTA |
| `src/screens/InvoiceBuilderScreen.tsx` | Pre-flight quota check before save; "N of 200 documents used" hint |
| Gated screens (`ExpensesScreen`, `PurchasesScreen`, `ReportsScreen`, `DataImportScreen`, `DataExportScreen`, `TeamScreen`, `RolesScreen`, `ActivityLogScreen`, `InvoiceTemplateScreen`, `GstReturnsScreen`) | `LockedFeatureBadge` / `UpgradeSheet` when the entitlement is absent |
| `src/services/analytics.ts` | Events: `paywall_shown`, `upgrade_started`, `upgrade_completed`, `quota_warning`, `quota_blocked`, `trial_started`, `plan_viewed` |

---

## 6. Risks

### 6.1 Auto-renew does not exist with Razorpay Orders — **ACCEPTED (Decision 1)**
Per D9, BillJi owns the cycle, which means no mandate, which means every renewal is a manual
repurchase. Expect meaningful involuntary churn at renewal. Mitigation: reminders at T-7/T-3/T-1,
generous grace, and prioritise UPI Autopay in Phase 6. **If auto-renew is required at launch,
say so now** — it changes the provider interface (`createMandate`/`charge`) and Phase 6 moves to Phase 3.

### 6.2 Webhook signature verification vs the global JSON parser (correctness — will silently break)
`app.js` applies `express.json()` to everything before routes. Razorpay's HMAC is computed over
the **exact raw bytes**; a parsed-and-restringified body will not match. The webhook route must be
mounted with `express.raw({type:'application/json'})` *before* the global parser (or `express.json`
gains a `verify` hook stashing `req.rawBody`). Getting this wrong means either every webhook is
rejected, or — far worse — signature checking is quietly disabled to "make it work".

### 6.3 Offline documents vs hard quota — **RESOLVED: count-but-allow (Decision 3)**
Invoices are created offline and pushed later via `/sync`. If the business is over quota at push
time, the document already exists on paper, in the customer's hands, with a printed number.
Rejecting it corrupts the number sequence and destroys trust.
**Recommendation:** the sync push path **counts but never blocks** (records the overage, flags the
business, prompts an upgrade). Hard blocking happens only on the interactive online create path
plus a client-side pre-check from the cached entitlement. A small, bounded amount of free overage
is far cheaper than a customer whose real invoice vanished.

### 6.4 Google Play billing policy — **OPEN, does not block engineering (Decision 4)**
Selling in-app digital subscriptions on Android normally requires Google Play Billing (15–30%).
India's CCI rulings and User Choice Billing create a path for external payment, but the rules are
narrow and have changed repeatedly. At ₹249–₹499/month a 30% cut materially changes unit economics,
and non-compliance risks app removal. **This is legal/policy work, not engineering** — already
flagged in `docs/monetization-strategy-review.md:490` and still unresolved. Get an answer before
Phase 5 ships. Fallback: web-only checkout (mobile links out to a browser), which Play's rules
treat differently but which also hurts conversion.

### 6.5 Turning limits on for existing users is a downgrade — **RESOLVED: grandfather (Decision 2)**
Every current user has unlimited everything free. Starter (200 docs, 1 user, no expenses/reports/
import/export) is strictly worse for them, and `teamLimitService` currently allows 2 members where
Starter allows 1. Silently shrinking that will produce support load and 1-star reviews.
**Recommendation:** grandfather all pre-launch businesses onto a `legacy_pro` **private plan** with
Pro-equivalent entitlements, price ₹0, no expiry, `pricing.locked = true` — one migration, zero
angry users, and it costs nothing since these users pay nothing today either way. It is also the
cleanest possible demonstration that D1's snapshot design works.

### 6.6 Client-side gating must fail **closed**, unlike `usePermissions`
`usePermissions` fails *open* for owners so they can never be locked out of their own business —
correct for RBAC. For entitlements, failing open means the paywall is bypassed by clearing app
data. `useEntitlements` must fail **closed** (no subscription data → treat as Starter), and the
backend must re-check every single time regardless of what the client believed. Client gating is
UX; the server is the licence.

### 6.7 Money must be integer paise
Every amount is a `Number` of paise. Floats accumulate error and produce signature/reconciliation
mismatches with Razorpay (which itself uses paise). One schema comment, enforced in validation.

### 6.8 Usage counter races
Two concurrent invoice creates must not both pass a read-then-write check. The only safe form is a
single guarded atomic update (`findOneAndUpdate({business, periodKey, metric, count: {$lt: limit}}, {$inc:{count:1}}, {upsert:true})`),
with `E11000` on the unique index meaning "row exists, limit reached". Same for coupon redemption
counts. `NumberSequence` already proves this idiom in this codebase.

### 6.9 Entitlement lookup on every request (performance)
One extra indexed query per request is acceptable; `protect` already does 4. Mitigation: attach the
subscription in `protect` alongside `req.business` (one fetch, reused by every downstream guard),
plus a short in-process TTL cache on the `Plans` collection (which is tiny and rarely changes).
Do **not** cache subscriptions in-process across a fleet — that reintroduces the stale-index class of
bug already fixed once in this codebase.

### 6.10 Multi-business is a feature that must be built, not gated — **CONFIRMED in scope (Decision 6)**
"Multi Business (10)" implies an endpoint that does not exist (§1.2 item 5). `POST /businesses`
plus owner-side workspace creation is real new work inside the Business-tier scope.

### 6.11 Refunds interact with entitlement
Refunding a subscription payment should revoke or shorten access; otherwise a refund is a free plan.
`refund.processed` → recompute `currentPeriodEnd` / set `expired`. Note the existing
`invoice-cancel-refund-gaps` convention concerns *customer* refunds and does not apply here — these
are two different money flows in two different collections.

### 6.12 Enterprise has no self-serve path
"Custom Pricing" cannot be a checkout button. Enterprise is a `visibility: private` plan assigned by
an admin, plus a "Contact sales" form. Scoped accordingly, not as a payment flow.

---

## 7. Migration plan

All steps additive and reversible. Existing behaviour is unchanged until enforcement is switched on
(Phase 4), which is itself behind a kill-switch env flag.

**M1 — Seed plans (zero risk).** `bootstrap/billing.js` upserts Starter/Pro/Business/Enterprise from
`PLAN_SEEDS` by `key`. Idempotent (learned from the non-idempotent-seed bug already fixed in this repo).
Also seeds `legacy_pro` (private).

**M2 — Backfill subscriptions.** One `Subscription` per existing `Business`:
- Plan = `legacy_pro` (per §6.5), or Starter if you overrule that.
- `entitlements` snapshotted from the plan; `status: 'active'`; `currentPeriodEnd: null`;
  `pricing.locked: true`.
- Any `Business.plan.maxMembers` override → `Subscription.overrides.limits.team_members`.
- `Business.plan` mirror updated.
- `SubscriptionHistory { action: 'created', actor: 'system', note: 'legacy backfill' }`.
- Idempotent (skip businesses that already have one), batched, resumable, dry-run flag.

**M3 — Seed current-period usage.** For each business, count this month's issued documents into
`SubscriptionUsage{periodKey: current, metric: 'documents_per_month'}` so day-1 meters are honest.

**M4 — Platform admin.** `platformRole` defaults to `'none'`; a one-off script promotes the founder
account. No data change for anyone else.

**M5 — Business.plan enum removal.** Dropping the enum is backward-compatible (Mongoose only
validates on write). No document rewrite needed.

**M6 — Enable enforcement.** `BILLING_ENFORCEMENT=off|warn|on` in env.
`warn` logs + emits analytics for every would-be block without blocking — run it in production for
1–2 weeks to see exactly who would be hit and size the churn before flipping to `on`. This staged
flip is the single cheapest risk reduction available.

**Rollback:** `BILLING_ENFORCEMENT=off` restores today's behaviour instantly. New collections are
inert when unread; new fields are additive. No destructive migration anywhere in the plan.

---

## 8. Upgrade flow (locked feature → paid)

```
User taps a locked feature
  ↓ useEntitlements().can('expenses') === false   (no network round-trip)
UpgradeSheet opens
  ↓ shows: what this feature does · current plan · cheapest plan granting it (from requiredPlans[])
"See all plans" → PlansScreen (comparison, monthly/yearly toggle)
  ↓ "Upgrade to Pro"
POST /billing/checkout { planKey:'pro', interval:'year', couponCode? }   [idempotent]
  ↓ { orderId, amount, providerKeyId }
RazorpayCheckoutSheet (existing react-native-webview)
  ↓ payment success callback
POST /billing/checkout/verify { orderId, paymentId, signature }   ← fast path (UX)
Razorpay webhook payment.captured                                 ← authority (correctness)
  whichever lands first activates; the second is deduped on webhookEventId
  ↓
subscriptionService.activate(): snapshot plan → set period → history → mirror Business.plan
  ↓
AppToast success (per repo convention) · invalidate queryKeys.billing.* + auth.me
  ↓
feature is unlocked
```

Server-side, a blocked API call returns `402` with `requiredPlans[]`; `client.ts` converts it to a
`PaywallError` which opens the same `UpgradeSheet`. One flow, two entry points.

---

## 9. Implementation roadmap

Each phase is independently shippable, ends green, and leaves the app fully working. Nothing user-visible
changes until Phase 5; nothing is *enforced* until Phase 6.

| Phase | Scope | Deliverable | Risk |
|---|---|---|---|
| **P0** | This document | Approval | — |
| **P1** ✅ **DONE** | Catalog + models + seeding + the three engines. See §12 | Data layer + engines exist, nothing reads them | None — 418/418 tests pass |
| **P2** ✅ **DONE** | Read-only API + stable DTO. `protect` attaches lazy `req.access()`, `GET /billing/{plans,subscription,usage}`, `subscription` block on auth responses, `teamLimitService` delegates. See §13 | Read-only truth, no blocking | Low — 445/445 tests pass |
| **P3** ✅ **DONE** | Provider layer + Razorpay. `payments/` registry, razorpay + manual providers, checkout/verify, raw-body webhook (§6.2), refunds, coupons, trial/cancel/reactivate, receipt numbering. See §14 | Money can be taken | **High** — 532/532 tests pass; needs a sandbox smoke test before production |
| **P4** | Guards in `warn` mode. `requireFeature`/`requireLimit` on all routes, in-controller quota checks, sync-registry `feature`/`meter` fields, `BILLING_ENFORCEMENT=warn`. Analytics on every would-be block | Full visibility, zero blocking | Medium — §1.3 is here |
| **P5** | Mobile. `useEntitlements`, `SubscriptionScreen`, `PlansScreen`, `UpgradeSheet`, `RazorpayCheckoutSheet`, usage meters, lock badges, `402` interception, analytics | Users can see + buy plans | Medium |
| **P6** | Admin API. `platformRole`, `requirePlatformAdmin`, plan/subscription/coupon/payment/metrics endpoints | Plans manageable without deploys | Low |
| **P7** | Migrations + rollout. M1–M5, then `warn` in production 1–2 weeks, then `on`. Dunning job, trial-ending + renewal notifications | Enforcement live | **High** — churn, §6.5 |
| **P8** *(later, on demand)* | Auto-renew (UPI Autopay mandates), add-ons, Build-Your-Own-Plan, Stripe, admin web UI, API access | — | — |

Estimated: P1–P2 ≈ 1 week · P3 ≈ 1–1.5 weeks · P4 ≈ 0.5 week · P5 ≈ 1–1.5 weeks · P6 ≈ 0.5 week ·
P7 ≈ 0.5 week + 2 weeks observation. **≈5–6 weeks of build, plus the observation window.**

---

## 10. Testing plan (`backend/tests/`, `node:test` + `mongodb-memory-server`, existing helpers)

**Unit** — snapshot build from plan; `resolveStatus` across every date boundary (active/grace/expired/
trial/cancel-at-period-end); limit math incl. `-1` unlimited; `periodKeyFor` month rollover incl. timezone;
proration on upgrade; coupon validity (window, plan scope, per-business cap, first-time-only); price
computation in paise.

**Integration** — Starter blocked from expenses/imports/reports (`402 FEATURE_NOT_IN_PLAN`); document #201
blocked, #200 allowed; usage resets on new `periodKey` with no job run; team invite blocked at seat limit
(extends the existing `tests/planLimit.test.js` + `team.test.js`); business #2 blocked on Starter; overrides
beat the snapshot; **plan edit does not change an existing subscription's entitlements** (the D1 guarantee);
grandfathered `legacy_pro` keeps access.

**Payments** — checkout creates `created` payment + provider order; valid signature activates; **invalid
signature rejected**; tampered amount rejected; duplicate webhook deduped via `webhookEventId`; webhook with
a mangled/parsed body fails the HMAC (the §6.2 regression test — asserts the raw-body mount stays); refund
shortens access; manual provider pending → admin-captured → activated.

**Lifecycle** — trial start (once only), trial expiry → Starter; renewal extends period + opens new usage
period; upgrade mid-cycle (immediate entitlements, prorated); downgrade at period end (entitlements survive
until then); cancel keeps access to `currentPeriodEnd`; reactivate; grace window grants access then revokes.

**Concurrency** — 50 parallel document creates at limit 200 land on exactly 200 (the §6.8 guarantee);
parallel coupon redemptions never exceed `maxRedemptions`; two parallel checkouts with one idempotency key
create one order.

**Sync** — offline invoice pushed while over quota is **accepted and counted, not rejected** (§6.3);
a sync op requiring a locked feature is rejected with the same `402` code as its route (the §1.3 guarantee).

**Mobile (Jest)** — `useEntitlements` fails **closed** with no data (§6.6); `402` → `PaywallError` → sheet;
usage meter thresholds; `PlansScreen` renders from API data with **no hardcoded plan names**.

---

## 11. Decisions — all resolved

Every question this document raised has been answered. See **§0** for the locked decision table.
Nothing in §0 may be changed by a later phase without an explicit new approval.

The one item still open is Google Play Billing (§6.4), which by Decision 4 does not block
engineering and must be answered before the mobile phase (P5) ships to production.

---

## 12. Phase 1 — implemented

Shipped: catalogs, models, schemas, seeders, and the snapshot / feature / limit engines.
**No payments, no mobile UI, no admin API, no enforcement.** Existing behaviour is byte-for-byte
unchanged — nothing reads the new collections yet.

### 12.1 New files

| File | Role |
|---|---|
| `src/constants/entitlements.js` | The catalog. 39 feature keys in 10 groups, 11 limit definitions, 5 plan seeds, `UNLIMITED = -1`. Every key `snake_case` and permanent |
| `src/models/Plan.js` | Admin-editable plan rows. Exports the shared `paise` money type, `entitlementsSchema`, and `assertKnownEntitlementKeys` |
| `src/models/Subscription.js` | One per business (unique). Carries the entitlement **snapshot**, period/grace dates, trial, cancel, pause, pricing, coupon, provider, `addOns[]`, `overrides` |
| `src/models/SubscriptionUsage.js` | Generic `(business, periodKey, metric)` counter with `overage` |
| `src/models/SubscriptionHistory.js` | Append-only lifecycle ledger with before/after snapshots |
| `src/models/SubscriptionPayment.js` | BillJi's own revenue. Schema only |
| `src/models/Coupon.js` | `Coupon` + `CouponRedemption`. Schema only |
| `src/services/entitlementService.js` | **Feature engine.** `resolveEntitlements`, `canAccessFeature`, `getLimit`, `plansGrantingFeature`, default-plan cache |
| `src/services/usageService.js` | **Limit engine.** `periodKeyFor`, `checkLimit`, `incrementUsage` (guarded atomic), `recordOverage`, `decrementUsage`, `usageSummary`, `setUsage` |
| `src/services/subscriptionService.js` | **Snapshot engine.** `buildSnapshot`, `resolveStatus`, `resolveAccess`, `applyPlan`, `ensureSubscription`, `resnapshot`, `syncBusinessMirror` |
| `src/bootstrap/billing.js` | Idempotent plan seeder that does not stomp admin edits (`{force:true}` to override) |
| `tests/entitlementCatalog.test.js` | 15 tests — catalog integrity, tier supersets, approved price/limit matrix, seeder idempotency |
| `tests/subscriptionSnapshot.test.js` | 24 tests — snapshot immutability, status resolution, grandfathering, overrides, add-on merge |
| `tests/usageEngine.test.js` | 20 tests — period keys, ceilings, month rollover, concurrency, offline overage |

### 12.2 Modified files

| File | Change | Compatible? |
|---|---|---|
| `src/models/Business.js` | `plan` becomes a documented read-only mirror (`key`, `subscriptionStatus`, `updatedAt`, `maxMembers` deprecated). Enum dropped — a fixed key list contradicts admin-created plans | Yes. Mongoose validates only on write; existing docs and `teamLimitService` are unaffected |
| `src/models/User.js` | `+ platformRole: 'none'|'support'|'admin'` (default `'none'`), indexed. Schema only | Yes, additive |
| `src/server.js` | `await bootstrapBilling()` after `bootstrapRbac()` | Yes |
| `src/seed/index.js` | Seeds plans, clears prior `Subscription` rows, puts the demo business on Starter | Yes |

### 12.3 Deviations from the original Phase 0 draft

Three reductions, no architectural change. Every locked rule in §0 still holds.

1. **No `Feature` collection.** A feature key must exist in code for any code path to check it,
   so DB rows duplicate the catalog with no reader. The admin plan editor (P6) serves the
   catalog over HTTP instead. Recreating it later is one file and changes nothing else.
2. **No `SubscriptionAddOn` collection** — `Subscription.addOns[]` instead (§3.7). One reader,
   one document, no join. `ponytail:` ceiling — an unbounded embedded array would be wrong if a
   business ever accumulates hundreds of add-on purchases; split it out then.
3. **Keys are `snake_case`, not the draft's camelCase examples** (`documents_per_month`, not
   `documentsPerMonth`), per the locked feature-key rule. camelCase accessors are derived:
   `LIMITS.documentsPerMonth === 'documents_per_month'`.

Also decided during implementation:

- **Quota months use business time (fixed UTC+05:30), not server time.** A shop billing at
  00:30 IST on the 1st must land in the new month; UTC bucketing would file it under the old
  one. India-only, no DST, so a fixed offset is correct and deterministic regardless of the
  server's `TZ`. `ponytail:` per-business timezones would need a real tz library — add only if
  BillJi ships outside India.
- **`resolveAccess` falls back to the default plan** when a subscription is expired, cancelled
  or absent — a lapsed customer must still be able to open their own invoices. Returning "no
  entitlements" would lock people out of their own data over a billing lapse.
- **`in_grace` and `past_due` are entitled statuses.** A late renewal must not lock out a
  paying customer.

### 12.4 Migrations

`bootstrapBilling()` (M1) runs on every boot and is the only migration in Phase 1. It creates
Starter / Pro / Business / Enterprise / `legacy_pro` if absent and refreshes presentation fields
otherwise. No existing document is read or rewritten.

M2–M5 (subscription backfill, usage seeding, admin promotion) stay in **P7** as designed —
`ensureSubscription` and `setUsage` are the primitives they will call, and both are idempotent.

### 12.5 Breaking changes

**None.** No API changed, no response shape changed, no existing document was rewritten, no
enforcement exists. The only schema change to a live collection is the removal of an enum
(strictly more permissive) and one additive `User` field.

Full suite: **418 tests, 418 pass** — 59 new, zero regressions.

### 12.6 Deliberately NOT wired yet

- `ensureSubscription` is **not** called on register/Google-signup. `resolveAccess` already
  handles a business with no subscription (falls back to Starter, tested), and the P7 backfill
  covers everyone at once. Wiring signup belongs with the read APIs in P2.
- `teamLimitService` still uses its own hardcoded `PLAN_LIMITS` map. Moving it onto the limit
  engine is P2 — doing it now would change live behaviour with nothing to verify against.
- Nothing reads `platformRole`. The guard is P6.

---

## 13. Phase 2 — implemented

Read-only billing API plus the stable mobile DTO. **No checkout, no guards, no mobile UI, no
enforcement.** The app can now *see* its plan; nothing can block on it yet.

### 13.1 The stable DTO — `src/contracts/billingDto.js`

Every endpoint that reports the current subscription serialises through `subscriptionDto()`:
`GET /billing/subscription`, `GET /billing/usage`, and the `subscription` block on
`/auth/{login,register,me,refresh,switch-business}` and `PATCH /settings`. One shape, one place
to change it, and a test asserts `/auth/me` and `/billing/subscription` are byte-identical.

Contracted fields (a missing one is a breaking change):

| Field | Meaning |
|---|---|
| `planId` | Durable plan identity. The only plan reference business logic may use |
| `planName` | Display name. Editable marketing copy |
| `planKey` | Stable slug for analytics/copy lookups. **Never** branch on it |
| `snapshotVersion` | Plan version the entitlements were copied from — answers "what exactly did this customer buy?" |
| `subscriptionStatus` | `trialing` \| `active` \| `in_grace` \| `past_due` \| `cancelled` \| `expired` \| `paused` \| `none` |
| `renewalDate` | When the next payment is due. `null` for free/lifetime **or when a cancellation is pending** |
| `expiryDate` | When access actually ends. `null` when it never does |
| `gracePeriodEndsAt` | Last instant of access after `expiryDate` |
| `usageSummary` | Per-limit rows: `key, label, unit, used, limit, remaining, percentUsed, unlimited, overage, resetsAt` |
| `remainingLimits` | Flat `{ key: remaining }` for cheap lookups |
| `features` / `limits` | Resolved entitlements (snapshot + add-on grants + overrides, already merged) |
| `isTrial`, `trialEndsAt`, `inGracePeriod`, `cancelAtPeriodEnd`, `billingInterval` | UI state |
| `contractVersion` | `BILLING_CONTRACT_VERSION`, currently `1` |

Two conventions the DTO enforces so clients never learn an internal convention:

- **`null` means unlimited.** The `-1` sentinel never crosses the wire, in any field.
- **Money is integer paise, unformatted.** Formatting bakes currency and locale into the API.

Deliberately **not** exposed, and asserted absent by a test: Mongo internals (`_id`, `__v`,
timestamps, raw entitlement Maps), provider metadata (name, `customerId`, `subscriptionId`,
`mandateId`, order/payment ids), `overrides` and `addOns` as separate fields (already merged — a
client must never need to know a value came from an override), coupon internals, sales `notes`,
`pause`, plan `meta`, and engine mechanics (`periodKey`, `limitAtTime`, `metered`).

**Change rule:** fields may be added freely. Removing or repurposing one breaks every app build
already in users' hands — bump `BILLING_CONTRACT_VERSION` and keep the old field until those
builds are gone.

### 13.2 New files

| File | Role |
|---|---|
| `src/contracts/billingDto.js` | `subscriptionDto`, `planDto`, `BILLING_CONTRACT_VERSION` |
| `src/modules/billing/service.js` | `currentSubscription`, `listPlans`, `liveCounts` |
| `src/modules/billing/controller.js` | The three read endpoints |
| `src/modules/billing/routes.js` | Mounted at `/api/v1/billing` |
| `tests/billingApi.test.js` | 20 tests — every contracted field, no-leak assertions, date semantics, unlimited-as-null, overage, signup provisioning |

### 13.3 Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/billing/subscription` | `{ success, subscription: <DTO> }` |
| GET | `/api/v1/billing/usage` | `{ success, usage: { contractVersion, subscriptionStatus, usageSummary, remainingLimits } }` |
| GET | `/api/v1/billing/plans` | `{ success, plans: planDto[] }` — active + **public** only; enterprise and `legacy_pro` are never listed |

Guarded with `settingsView`/`settingsManage`. The dedicated `billing.view` / `billing.manage`
permission pair is deferred to P3: there is nothing to authorise separately until something can
be changed or charged, and adding permissions early means a re-seed plus a mobile mirror update
for no behaviour.

### 13.4 Modified files

| File | Change | Compatible? |
|---|---|---|
| `src/middlewares/auth.js` | `protect` attaches `req.access()` — a **lazy, per-request-memoized** resolver. Not eager: most requests never look, and resolving on every one would add a query app-wide. Several guards on one route share a single fetch | Yes, additive |
| `src/controllers/authController.js` | `publicUser()` gains `subscription: <DTO>`; register + Google signup call `ensureSubscription` | Yes, additive. Provisioning is non-fatal — a signup must never fail over billing setup |
| `src/services/teamLimitService.js` | `canInvite` delegates to the limit engine, reading `team_members` from the snapshot (+ overrides) | See §13.5 |
| `src/modules/billing/*`, `src/routes/index.js` | New `/billing` mount | Yes |
| `src/constants/entitlements.js` | `legacy_pro.team_members: 1 → 2` | See §13.5 |

### 13.5 The one real behaviour change, and how it is contained

`teamLimitService` is the only pre-existing enforcement in the app, so moving it onto the limit
engine changes live behaviour — before the `BILLING_ENFORCEMENT` warn-mode flip exists. Two
guards contain it:

1. **No subscription row ⇒ legacy caps.** A business that predates billing keeps the old
   `{free:2, pro:5, business:15, enterprise:∞}` map until the P7 backfill gives it a
   subscription. Nothing creates subscriptions for existing businesses yet, so today's users are
   untouched. New signups get a subscription immediately and go through the engine (Starter = 1
   seat), which is the intended behaviour for them.
2. **`legacy_pro` grants 2 seats, not Pro's 1.** Pro is 1 seat by Decision 5, but the pre-billing
   free cap was 2 — so backfilling a two-member business onto Pro-equivalent entitlements would
   take a member away. Decision 2 (never silently downgrade) outranks tier symmetry. This plan is
   grandfathering, not Pro.

### 13.6 Breaking changes

**None.** `subscription` is an additive field on auth responses; no existing field changed shape.
`canInvite`'s signature and return shape are unchanged (unlimited reports as `Infinity`, which is
what its one caller already compares numerically).

Full suite: **445 tests, 445 pass** — 27 new since P1, zero regressions.

### 13.7 Still not wired

- **Nothing enforces anything.** `req.access()` exists and is exercised by the billing endpoints,
  but no route guard reads it yet — that is P4, behind `BILLING_ENFORCEMENT=off|warn|on`.
- No `couponService` (P3, with checkout), no `POST /businesses` (needs the `businesses` limit
  guard, so P4), no mobile types or screens (P5), no admin API (P6).

---

## 14. Phase 3 — implemented

Money can now be taken. **No guards, no mobile UI, no admin API** — nothing is enforced yet.

### 14.1 Provider layer

`src/services/payments/` — the only place in the codebase that knows a processor exists. Nothing in
`subscriptionService`, `entitlementService` or `usageService` imports a provider, so adding Stripe
changes no business logic.

Interface: `name`, `isConfigured()`, `publicConfig()`, `createOrder()`, `verifyPaymentSignature()`,
`fetchPayment()`, `refund()`, `parseWebhook()`. Deliberately **not** in it: anything about plans,
periods, entitlements, trials or renewals. A provider confirms money moved; that is the whole job.

| File | Role |
|---|---|
| `payments/index.js` | Registry. `getProvider()` throws **503** when credentials are missing — a half-configured processor must never fall through to a free activation |
| `payments/razorpayProvider.js` | Razorpay over its REST API |
| `payments/manualProvider.js` | Bank transfer / UPI collect / enterprise invoice. Mints a reference, sits `created`, a human marks it captured |

**No `razorpay` SDK dependency.** The whole surface we need is four REST calls and one HMAC; the SDK
is a thin wrapper over exactly those, and a money path is easier to audit when the wire format is
visible in the file. `manualProvider` exists now rather than "later" because an abstraction with one
implementation is a guess, not an abstraction — and Enterprise (NEFT against an invoice) needs it.

### 14.2 Checkout, and why the order of writes matters

`src/services/billingService.js` — the only module that talks to a provider.

**Our payment row is written before the provider is called.** Reversed, a failed write would leave
an order at Razorpay that BillJi has no record of, and money could be taken against something we
cannot match to a business. The failure mode we chose instead is an abandoned `created` row, which
is inert and hidden from payment history.

`POST /billing/checkout` runs under the existing `idempotency()` middleware: a double tap on
"Upgrade", or a retry over a flaky mobile connection, replays the first order rather than opening a
second one the customer could pay twice.

**Two independent checks before anything is granted** on the client-confirm path:

1. the HMAC over `order_id|payment_id` proves Razorpay produced the pair, and
2. a re-fetch of the payment proves it is actually `captured` **for the amount we asked**.

The signature alone would let a client replay a genuine pair from a different, unfinished attempt.
Amount, plan, period and entitlements always come from our own row — never from the client, never
from the event body. A test asserts that a lying event cannot change the price.

### 14.3 Activation is idempotent by construction

Both the client verify path and the webhook call `activateFromPayment()`, whose first act is an
atomic `status: created|authorized → captured` claim. Exactly one caller wins; the loser returns the
already-active subscription instead of extending the period again. Tested by firing both
concurrently and asserting exactly one activation row in `SubscriptionHistory`.

If money is captured but the plan row has since vanished, the payment stays `captured` and is
flagged for support. **Never roll back a real charge** to keep our own data tidy.

### 14.4 Webhooks — the section 6.2 trap, closed

Mounted in `app.js` **before** the global `express.json()`, with `express.raw({type:'*/*'})`. The
HMAC covers the exact bytes Razorpay sent; a parsed-and-restringified body cannot verify, and the
only ways out of that would be to reject every webhook or to stop checking signatures.
`tests/billingWebhook.test.js` posts a body whose spacing and key order `JSON.stringify` would not
reproduce — **if the mount ever regresses below the JSON parser, that test fails.**

Response policy: **400** only for a bad signature (do not retry a forgery). **200** for unhandled
event types and for signed events matching no payment — retrying will not make an unknown event
known. **5xx** only when applying a genuine event failed on our side, which is the one case that
should be retried.

**Dedup:** `SubscriptionPayment.webhookEventId` (scalar) became `webhookEventIds: [String]`.
A deviation from section 3.5, and a necessary one: one payment legitimately receives several
distinct events (`payment.captured`, later `refund.processed`), so a scalar would be overwritten and
a redelivered capture could activate twice. A guarded `{ webhookEventIds: { $ne: eventId } }` update
dedups every event type atomically, with no separate event collection. Tested.

Also verified: a signature made with the **API** secret instead of the **webhook** secret is
rejected — otherwise anyone holding the API key could forge activations. Production env now refuses
to boot half-configured (a Razorpay key without a webhook secret).

### 14.5 Coupons, trial, cancel, refunds

- **Coupons** — `couponService`. One validator answers both "is this code good?" (dry run) and
  "charge this amount", so a preview and a checkout cannot disagree. Redemption claims a slot with a
  guarded `$inc`, so a viral code cannot exceed its cap under concurrency (tested with 10 concurrent
  redemptions against a cap of 3). A discount never exceeds the price. A bad code is reported, never
  silently charged at full price. Redeemed **on capture**, released on full refund.
- **Trial** — a snapshot like any other, with an end date and a one-shot `trial.used` latch on the
  subscription, so switching plans cannot yield a second trial. Expiry falls back to Starter.
- **Cancel** — access continues to the end of the period already paid for; taking it away on click
  would be keeping money for time not served. `immediate` is rejected for customers (support only).
- **Refunds** — a full refund ends the period (a refund that leaves the plan running is a free
  plan); a partial one does not. A refund of an *older* payment cannot revoke a newer paid period.
  Reachable from the service and from a dashboard-issued refund arriving as a webhook; the customer
  route is P6 admin.
- **Proration** — an upgrade credits the unused part of the current period, or nobody upgrades
  mid-cycle. Renewals get no credit (they already extend from the period end, so crediting would pay
  twice for the same days). `ponytail:` straight-line, credit-only, no carry-forward.

### 14.6 Receipts — number now, document later

`nextReceiptNumber()` allocates `BILLJI/<FY>/000123` on the Indian financial year, so the series is
continuous from the first rupee.

**A number, not a GST tax invoice.** Issuing one needs BillJi's own GSTIN, the SAC code for the
service, and a place-of-supply rule to pick IGST vs CGST+SGST from the customer's state — product
and compliance decisions, not engineering ones. Rendering the PDF is a day's work once those three
answers exist; inventing them would produce a tax document that is wrong. **Open item.**

### 14.7 New endpoints

| Method | Path | Guard |
|---|---|---|
| POST | `/billing/checkout` | `billing.manage` + idempotency |
| POST | `/billing/checkout/verify` | `billing.manage` |
| POST | `/billing/coupons/preview` | `billing.view` |
| POST | `/billing/trial` | `billing.manage` |
| POST | `/billing/cancel` | `billing.manage` |
| POST | `/billing/reactivate` | `billing.manage` |
| GET | `/billing/payments` | `billing.view` |
| POST | `/billing/webhooks/:provider` | HMAC signature (no session) |

New permissions `billing.view` / `billing.manage`, seeded by the existing idempotent
`bootstrapRbac`. Separate from `settings.manage` on purpose: editing an invoice template and
spending the owner's money are not the same trust level. Accountant and viewer get `view`;
owner/admin get both automatically (they hold every permission).

### 14.8 Files

**New (8):** `services/payments/{index,razorpayProvider,manualProvider}.js`,
`services/billingService.js`, `services/couponService.js`,
`modules/billing/{checkoutController,webhookController,webhookRoutes}.js`

**Tests (4):** `tests/helpers/razorpayStub.js` (a fetch-level fake — stubbing the HTTP boundary
exercises URL, auth, body shape, error mapping and the real HMAC code paths; stubbing the provider
module would test only the double), `tests/billingCheckout.test.js` (44),
`tests/billingWebhook.test.js` (22), `tests/paymentProviders.test.js` (18)

**Modified (8):** `app.js` (raw-body webhook mount ahead of the JSON parser), `config/env.js`
(razorpay block + half-configured production guard), `constants/permissions.js` +
`middlewares/authorization.js` (billing permissions), `middlewares/rateLimit.js` (`webhookLimiter`,
IP-keyed — a provider retry storm must not consume the app's shared budget),
`models/SubscriptionPayment.js` (`webhookEventIds`), `services/subscriptionService.js`
(`startTrial`, `cancelSubscription`, `reactivateSubscription`; renewals extend from the existing
period end so renewing early loses no days), `contracts/billingDto.js` (`paymentDto`),
`modules/billing/routes.js`

### 14.9 Breaking changes

**None for clients.** All new endpoints; `paymentDto` is a new shape. One internal schema change —
`webhookEventId` to `webhookEventIds` on `SubscriptionPayment` — with no production rows to migrate,
since P1/P2 shipped without a payment path.

Full suite: **532 tests, 532 pass** — 87 new since P2, zero regressions.

### 14.10 Before production

1. **Sandbox smoke test.** Every test here runs against a fetch-level fake. The real Razorpay
   sandbox must be exercised once end to end — order, checkout, capture, a real signed webhook
   delivery, a refund — before a rupee moves. A fake cannot catch a field Razorpay renamed.
2. **Set `RAZORPAY_WEBHOOK_SECRET`** and subscribe the endpoint to `payment.captured`,
   `payment.failed`, `order.paid`, `refund.created`, `refund.processed`.
3. **The GST receipt decisions in 14.6.**
4. **Google Play Billing (6.4)** still blocks P5 shipping, not P4 building.

---

## 15. Phase 4 — implemented

Enforcement exists and is **off by default**. `BILLING_ENFORCEMENT=off|warn|on` decides whether a
plan can refuse anything; `off` is byte-for-byte today's behaviour, and it is what ships.

### 15.1 One module, two questions kept apart

`src/middlewares/entitlement.js` is the only place allowed to turn an entitlement into a refusal.
RBAC answers "is this person allowed?" (**403**), this answers "did this business buy it?"
(**402**), and on every route `requirePermission` runs **first** — a staff member without
`expenses.view` is told that, and never shown a paywall for a module they could not use anyway.
A test asserts that order.

Nothing here re-implements the engines: it calls `canAccessFeature`, `checkLimit`,
`incrementUsage`, `plansGrantingFeature` and `logAudit`. No model, DTO, provider or subscription
service was touched.

| Export | Role |
|---|---|
| `enforcementMode()` | Reads `BILLING_ENFORCEMENT` **per call**. An unrecognised value reads as `off` — a typo must never start blocking paying customers |
| `requireFeature(key)` | Route guard. 402 `FEATURE_NOT_IN_PLAN` + `requiredPlans[]` |
| `requireLimit(key, countFor)` | Route guard for a live-counted limit. 402 `LIMIT_REACHED` |
| `checkFeatureAccess` / `checkLimitAllowed` | The same checks, express-free, for the sync path and in-controller use |
| `meterQuota` / `meterDocument` | Wraps a create in its metered quota: consumed before the write, released if the write fails |
| `attachBillingWarning` | Warn-mode metadata, injected by wrapping `res.json` once — no controller knows |
| `assertBusinessCreationAllowed` | `multi_business` + the `businesses` ceiling, ready for `POST /businesses` (see 15.7) |

### 15.2 The three modes

- **off** — never blocks, never warns. Metered creates are still **counted**, so day-one meters and
  the rollout decision are based on real numbers.
- **warn** — allows the action, records the overage, attaches `billingWarnings[]` to the response,
  and writes an AuditLog row for every would-be block (`billing.feature.warned`,
  `billing.limit.warned`, `billing.limit.overage`). This is the observation window in one flag.
- **on** — refuses with 402 and the cheapest plans that would grant the thing, computed by scanning
  plans. Never a hardcoded "requires Pro".

Warnings ride on the existing envelope (`{ success, …, billingWarnings: [...] }`), so warn mode
adds a field and changes no controller and no DTO.

### 15.3 What is guarded

| Surface | Guard |
|---|---|
| Expenses (all routes) | `expenses` |
| Purchases + vendors (all routes) | `purchases` |
| Imports — preview + commit | `data_import` + `imports_per_month` |
| Exports — request only | `data_export` + `exports_per_month` |
| GST returns (GSTR-1/3B) | `advanced_gst_reports` |
| Dashboard summary | `basic_reports` (every plan grants it — declared, not enforced-in-effect) |
| Audit log **reads** | `audit_logs`. Writing the trail never stops, whatever the plan |
| Team — invite / re-role / status | `teams` + the `team_members` ceiling |
| Roles — create / update | `custom_roles` |
| Sales documents — invoice, duplicate, quotation, challan, credit note, order→invoice | `documents_per_month` |

**Reads and shrinking stay open on purpose.** A downgraded business can still list its team,
remove a member, archive a custom role and download an archive it already paid for. Taking away
the ability to *undo* would trap people rather than upsell them.

### 15.4 The sync path — §1.3 closed

Route middleware never runs on `/sync/push`, so a guard written only as middleware is bypassed by
every offline-created document. Two changes close it:

1. **`feature` on the registry entry**, the subscription counterpart of the existing `permission`
   field. `runOperation` enforces it with the very same helper the routes use, so a rejected op
   comes back as a per-op 402 with upgrade options instead of failing the batch.
   *(Superseded by §16.6: a feature gate on this path no longer rejects — a 402 here stranded a record
   that already existed on the device. It warns, exactly as a limit does.)*
2. **`offlineSync: true` and a per-op `billingWarnings` array on the sub-request.** Warnings raised
   by one operation travel back on that operation's result and cannot leak into the other 49 —
   asserted by a test.

There is deliberately **no `meter` field**. Every metered create is metered inside its controller,
which this path *does* run; a registry-level meter would count the same document twice, which is
worse than not counting it.

### 15.5 The offline rule (Decision 3), enforced

**An already-issued document is never refused for a plan limit, in any mode.** The push path marks
the request offline, so `meterDocument` counts it, flags the overage, and returns
`LIMIT_EXCEEDED_OFFLINE` as a warning. Rejecting it would corrupt the number series and destroy
trust for a billing reason. Interactive online creation still enforces the ceiling.

*Widened in §16.6: the rule now covers **features** as well as limits, because the reasoning was never
specific to limits — anything created offline already exists.*

### 15.6 One real hole found and closed

A **ceiling of zero** was let through once per period: with no counter row yet, the engine's
guarded predicate `count: {$lte: -1}` matches nothing, so the upsert inserts and the first unit
succeeds. `consumeQuota` now short-circuits a zero ceiling. Handled in the enforcement layer so the
engine's proven atomic path is untouched. Tested.

### 15.7 Not wired, and why

- **`POST /businesses` does not exist** (§1.2, §6.10). `assertBusinessCreationAllowed` is written
  and unit-reachable, but a guard mounted on an endpoint that does not exist would be a guess. The
  `businesses` ceiling has nothing to gate until multi-business creation is built.
- **Advanced reports beyond GST returns** — `/reports/summary` is the only report endpoint. The
  `advanced_reports` key has no surface to guard yet.

### 15.8 Files

**New (2):** `src/middlewares/entitlement.js`, `tests/subscriptionEnforcement.test.js` (26)

**Modified (14):** `config/env.js` (`billing.enforcement`), `modules/{expenses,purchases,imports,
exports,gst}/routes.js`, `routes/{reportRoutes,auditRoutes,teamRoutes,roleRoutes}.js`,
`controllers/invoiceController.js`, `controllers/teamController.js`,
`modules/documents/controller.js`, `modules/orders/controller.js`,
`modules/imports/controller.js`, `modules/exports/controller.js`,
`modules/sync/{registry,service}.js`

### 15.9 Breaking changes

**None while `BILLING_ENFORCEMENT` is unset or `off`** — which is the shipped default. `warn` adds
an additive `billingWarnings[]` field. `on` changes the team-seat refusal from **403
`MEMBER_LIMIT_REACHED`** to **402 `LIMIT_REACHED`**; `off` keeps the old 403 exactly, so the one
limit the app already enforced does not loosen.

### 15.10 Before `on`

**The P7 backfill must land first.** A business with no `Subscription` row falls back to the
default plan's entitlements, so `on` would refuse Expenses to every pre-billing user — exactly the
silent downgrade Decision 2 forbids. A test asserts this behaviour so the dependency is visible
rather than discovered in production. Run `warn` for 1–2 weeks and read the
`billing.*.warned` / `billing.limit.overage` audit rows before flipping.

Full suite: **558 tests, 558 pass** — 26 new since P3, zero regressions.

---

## 16. Production stabilization sprint

Not a phase. The pre-production audit (`BillJi-Subscription-Billing-PreProd-Audit.md`) found defects
that only a running system produces: sequences of writes interrupted halfway, a provider that sends
two events for one thing, a mode meant to observe that quietly stopped enforcing. Architecture
unchanged; every fix is local to a file that already existed.

Two of these were **reproduced against the code** before being fixed, and both reproductions are now
permanent regression tests.

### 16.1 One refund counted twice (P0)

Razorpay sends `refund.created` **and** `refund.processed` for a single refund, with two different
event ids. Dedup was keyed on the event id, so:

- a ₹500 partial refund was recorded as ₹1,000 refunded (reproduced);
- two half-refunds summed to `netAmount`, flipping the payment to `refunded` and **cancelling a
  subscription the customer had only been half refunded for**;
- a full refund's second event re-ran the cancellation, threw `SUBSCRIPTION_ALREADY_CANCELLED`, and
  answered **500 forever** — so Razorpay retried a settled refund for hours (reproduced).

Idempotency is now keyed on the **refund id** (`SubscriptionPayment.refundIds[]`, the same
`$ne`-guard idiom as `webhookEventIds`). The arithmetic moved into an aggregation-pipeline update, so
the total is computed from the stored value inside one atomic operation — reading it into JS and
writing back a sum is the shape that produced the double-count. An already-cancelled subscription is
treated as success: the outcome the refund wanted is the outcome that holds.

### 16.2 Captured, never activated (P0)

`activateFromPayment` claims `created -> captured` atomically and *then* writes the subscription. A
restart in between takes the money, grants nothing, and — worst of all — makes every webhook retry
return `alreadyApplied: true`.

`applyCapturedPayment()` is that second half, split out so `billingReconciliation` can finish the row.
`subscription: null` on a `captured` payment is the marker, because that field is only written after
the plan is applied.

Recovery errs towards **not** re-applying: re-running a renewal would extend the period a second time,
a free year. It re-applies only when neither a `SubscriptionHistory` row for this payment nor a
matching subscription applied after the payment exists; otherwise it backfills the links. Coupon
redemption is guarded by an existing-redemption check for the same reason.

A recovery that fails is the one billing state that always needs a human — a customer who paid and has
nothing — so it audits `billing.activation.recovery_failed`. Money is never rolled back.

### 16.3 Receipt numbers collided (P1)

Allocation was read-max-then-add-1: two concurrent checkouts both read the same maximum and both
received `BILLJI/2026-27/000001` (reproduced). Now allocated through **NumberSequence**, the same
guarded `$inc` as every other series, scoped to a platform-wide sentinel business id so the existing
unique index does the work. A partial-unique index on `receipt.number` backs it up.

**Migration required before that index ships:** `scripts/migrate-receipt-sequence.mjs --fix`. If a
duplicate already exists the index will not build and the collection silently ships without the guard.

### 16.4 Duplicate orders and double-spent credit (P1)

The mobile client sent no `Idempotency-Key`, so the middleware short-circuited and a double tap minted
two payable orders. Two independent fixes, because either alone leaves a gap:

- **Client:** a *stable* key per purchase attempt (terms + a 5-minute bucket). The random
  `idempotencyKey()` helper the other endpoints use would have changed nothing.
- **Server:** an order still open for the same terms is handed back (`resumed: true`) rather than
  re-minted. This holds even for a client that forgets the header.

A checkout carrying a proration credit while another credit-bearing order is open is refused with
`CHECKOUT_ALREADY_OPEN`: paying both would buy one plan and spend the same unused days twice. The
credit's basis is recorded on the payment (`proratedCredit`, `creditBasisPeriodEnd`) so activation can
detect one that went stale anyway and audit `billing.proration.credit_stale` — money has already
moved by then, so prevention lives at checkout and this is only the detector.

### 16.5 Warn mode weakened a rule that already held (P1)

`warn` let an over-cap team invite through. The seat cap is the one limit this app enforced **before
billing existed**, so the rollout's own observation window was a seat-cap bypass. Every mode now
refuses; only the envelope differs (`off` 403, `warn` 403 + warning + `billing.limit.warned`, `on` 402
with upgrade options). **Warn may only ever add a warning.**

### 16.6 A feature gate stranded offline records (P1)

`on` mode answered 402 for an offline-created expense or purchase. The client classifies a 402 as
non-retryable, so the operation went **`dead`** in the outbox: the record existed on the device, could
never sync, and was lost at the next reinstall.

The offline rule (Decision 3) was never specific to limits — its reasoning is that the work already
happened. It now covers features: accepted, flagged `FEATURE_NOT_IN_PLAN_OFFLINE`, audited as
`billing.feature.overage_offline`. Online enforcement is untouched.

The trade-off, stated plainly: a modified client could push a feature the business never bought. It is
visible in the audit log, the app never offers the screen, and it is a better bargain than deleting a
customer's expenses to protect a paywall.

### 16.7 Lapsing mid-month zeroed the allowance (P1)

Usage is counted even on an unlimited plan (so the meters stay honest). A Pro business that issued
5,000 documents in August and lapsed on the 20th therefore inherited the free plan's 200 ceiling with
5,000 already in this month's counter: enforcement refused the very next document and kept refusing
until the 1st. Reads as "the app is broken", not "please renew".

A lapsed subscription now counts into a **separate bucket for the same month** — `periodKey` gains a
`:f` suffix while `entitlements.source === 'fallback'`. The free ceiling governs free-plan usage, so
free-plan usage is what it counts.

Why a suffixed key and not a `baseline` field: the counter's guarded predicate
`count: { $lte: limit - amount }` is the only reason two concurrent creates cannot both pass at
199/200, and arithmetic against a second field would have to change it. A different key is a different
row, so the proven atomic path is untouched. It also needs no lapse-detection job — the bucket follows
the resolved entitlements on every call, and renewing returns to the paid bucket by itself.

Only monthly limits split. An all-time metered limit (`storage_bytes`) is a stock, not a flow;
bucketing it would hand a lapsed business a second full allowance. `source: 'none'` (pre-billing, no
subscription) deliberately keeps the main bucket — moving it would split the very meters the rollout
decision reads.

### 16.8 Webhook amount validation (P1)

The client verify path always compared the provider's amount to our order; the webhook did not.
`amountMatchesPayment()` is now shared by both. A mismatch grants nothing, flags the row, audits
`billing.webhook.amount_mismatch` and answers **200** — retrying cannot make the amounts agree, so a
5xx would only buy hours of redelivery.

### 16.9 The safety net

`src/services/billingReconciliation.js`, on the existing scheduler (`claimJob`, so each body runs once
per window across the fleet):

| Job | Window | Does |
|---|---|---|
| `billing:reconcile-activations` | 5 min | Finishes captured-but-not-activated payments; alerts when it cannot |
| `billing:activation-failures` | 1 h | Keeps flagging captured payments that need a human |
| `billing:renewal-reminders` | 6 h | 7/3/1 days before expiry — V1 has no auto-renew, so silence meant losing access unannounced |
| `billing:grace-reminders` | 6 h | Inside the grace window |

Reminders need no "already told them?" flag: `upsertNotification` is keyed on
`(business, notificationId)` and the period end is in the key, so an hourly sweep is a no-op and pushes
exactly once, while next period's reminders are new rows.

### 16.10 Sandbox verification

`docs/razorpay-sandbox-verification.md` — env and secret separation, the migration, the preflight, the
five webhook events to subscribe, 14 device steps (double tap, dashboard half-then-full refund, event
redelivery, a forced crash window), and the audit actions to watch.
`scripts/billing-preflight.mjs` fails loudly on a half-configured provider, a missing unique index
(the engine's atomicity depends on three of them), enforcement left on, or no default plan.

### 16.11 Files

**New (6):** `src/services/billingReconciliation.js`, `tests/billingReconciliation.test.js`,
`scripts/migrate-receipt-sequence.mjs`, `scripts/billing-preflight.mjs`,
`docs/razorpay-sandbox-verification.md`, mobile `src/features/billing/__tests__/checkoutIdempotency.test.ts`

**Modified (10):** `services/billingService.js`, `services/usageService.js`,
`services/numberingService.js`, `models/SubscriptionPayment.js`, `middlewares/entitlement.js`,
`modules/billing/webhookController.js`, `modules/sync/service.js`, `controllers/teamController.js`,
`bootstrap/jobs.js`, mobile `api/endpoints.ts` (+ `types.ts`, `sync/pushEngine.ts` comment)

### 16.12 Breaking changes

No DTO field removed; `BILLING_CONTRACT_VERSION` unchanged. Three deliberate behaviour changes:

1. `warn` now refuses over-cap team invites (§16.5) — it previously allowed them, which was the bug.
2. A webhook whose amount disagrees with our order no longer activates (§16.8).
3. A second checkout for the same terms returns the open order with `resumed: true` (§16.4).

Additive: `refundIds[]`, `proratedCredit`, `creditBasisPeriodEnd` on `SubscriptionPayment`; the `:f`
period-key bucket; the `FEATURE_NOT_IN_PLAN_OFFLINE` warning code.

### 16.13 Still open

- **GST receipt** — `PlansScreen` claims "Prices include GST" while `tax` is always 0 and no tax
  invoice exists. Compliance decision (GSTIN, SAC, place-of-supply), not an engineering one. Either
  ship the document or soften the copy before invoices go out.
- **Locked pricing on self-serve renewal** — `quote()` prices from the plan and ignores
  `pricing.locked`. Latent (nothing sets it); P6's admin API is what turns it on.
- **P6 admin API, P7 backfill** — every remediation above is still a mongosh session, and `on` still
  must not be switched on before the backfill.
- **Never run against a real gateway or a real device.** The runbook exists precisely because tests
  cannot close this.

---

# 17. Autopay — implemented (revises D9)

Recurring payment by mandate (UPI Autopay / card e-mandate), offered **alongside** the one-time flow.
Autopay is the recommended default for a new purchase; manual stays a first-class path and is never
removed. Nothing about an existing manual subscriber changed.

## 17.1 What this revises, and what it does not

D9 (§2) chose Razorpay **Orders** and accepted "no auto-renew" as the consequence. §6.1 said the
quiet part out loud: *"If auto-renew is required at launch, say so now — it changes the provider
interface (`createMandate`/`charge`)."* This is that change.

Both mechanisms now exist, because they answer different questions:

| | Orders | Subscriptions |
|---|---|---|
| Buys | one period | a mandate + a debit schedule |
| Used for | manual purchase, every coupon, every prorated upgrade | autopay, **list price only** |
| Amount | fixed by the order we create | fixed by `Subscription.autopay.chargeAmount`, written at enrolment |

**D9's actual requirement survives.** BillJi still owns plans, entitlements, trials, grace, and every
period end: a `subscription.charged` event becomes a period through the *same*
`applyCapturedPayment → applyPlan({action:'renewed'})` funnel a manual renewal uses, with no
autopay-specific date arithmetic anywhere. What Razorpay is now allowed to own is the **cron** — plus
the RBI pre-debit notification (`customer_notify: 1`) and debit retries, which is the reason this beats
BillJi-scheduled token debits.

## 17.2 The three invariants

1. **A mandate is not money.** `subscription.authenticated` writes `autopay.status` and nothing else —
   no period, no payment row. Only a charge grants time.
2. **A period comes only from a charge with a payment id.** Never from a status read; `reconcileAutopayMandates`
   alerts and re-syncs, and deliberately cannot grant.
3. **The amount is checked against what we wrote before the debit.** `amountMatchesPayment` is *not*
   reusable here — the cycle row is built *from* the event, so it would pass tautologically. A mismatch
   records the money `captured` with a `failureReason` (never lost) and grants nothing (never given
   away); the existing `reportActivationFailures` sweep surfaces it.

## 17.3 Shape

- **No payment row at enrolment.** Every cycle row — including the first — is created from its own
  charge event, so cycle 1 and cycle 60 are one code path. A mandate that is never approved leaves
  nothing behind and burns no receipt number.
- **Dedup is the existing unique partial index on `providerRefs.paymentId`** (one provider payment per
  debit). `providerRefs.subscriptionId` is added and is **deliberately NOT unique** — every cycle of one
  mandate shares it, so the usual unique-partial pattern would make the *second* renewal fail to insert.
- Rows insert with `subscription: null`, so a crash between insert and activation heals through the
  existing 5-minute `reconcileCapturedPayments` with no changes to that job.
- **Provider plan ids are cached on `Plan.prices[].providerRefs`**, fingerprinted
  `razorpay:<interval>:<count>:<currency>:<amount>`. A provider plan is immutable, so the amount is part
  of the key and a repriced plan simply misses the cache. Nothing invalidates: mandates already running
  still reference the old provider plan, and the provider owns that link.
- **`resolveStatus` is untouched and `past_due` stays unused.** A failed debit is already classified
  correctly by dates (inside period → `active`, past it → `in_grace` → `expired`). Returning `past_due`
  would either grant access past grace or duplicate `in_grace`. Dunning lives in `autopay.status`, which
  the DTO exposes separately — clients must not gate features on it.
- **Cancelling stops the mandate FIRST, and strictly** (`billingService.cancelWithProvider`). If the
  provider will not confirm, nothing is cancelled locally: a cancelled subscription with a live mandate
  keeps debiting someone who cancelled. `applyRefund`'s full-refund branch routes through the same
  function, so both refund entry points became mandate-aware without a new import.
- `POST /billing/autopay/off` stops the mandate and touches nothing else — the period, plan and
  `cancel.*` are left alone, and the manual renewal reminders resume by themselves.
- Renewal reminders **skip** a working mandate rather than rewriting their copy: every failure state
  clears `autopay.enabled`, so those subscribers fall back into the existing reminder, where
  "Nothing is charged automatically" is true again.

## 17.4 Files

New: `src/services/autopayService.js` (lifecycle + `recordAutopayCharge` + `confirmAutopayMandate`),
`tests/billingAutopay*.test.js` (43 cases), `mobile/src/features/billing/checkoutBridge.ts`.
Changed: `payments/index.js` (+`supportsAutopay`, `getAutopayProvider`), `razorpayProvider.js`
(+5 mandate methods, `subscription.*` parsing, and a `PROVIDER_UNAUTHORIZED` branch — a 401 carries a
bare string, not Razorpay's usual `{error:{description}}`, so it used to surface as a reasonless 502),
`Subscription.autopay.*`, `SubscriptionPayment.providerRefs.subscriptionId`, `billingService`
(enrolment + `cancelWithProvider` + `disableAutopay`), `webhookController` (one early branch),
`billingReconciliation` (+2 sweeps), `billingDto` (additive `autopay` block — contract stays v1),
`notificationTypes.js` (also fixes `subscription-renewal`/`subscription-grace` never having been
mutable).

## 17.5 Still open

- **The Razorpay account does not have Subscriptions enabled.** The same sandbox key returns 200 on
  `POST /orders` and **401 on `/plans` and `/subscriptions`** — Subscriptions is a separate activation.
  Every autopay path is therefore stub-verified only; enable the product, then run the autopay live
  script and the device pass.
- **`total_count`** is 120 monthly / 10 yearly (`AUTOPAY_TOTAL_COUNT`). Decides what happens in year N
  and what the customer is told — product should confirm.
- **A live mandate cannot be repriced.** Current behaviour grandfathers it forever
  (`autopay.chargeAmount` is authoritative). Confirm that is the revenue policy.
- **UPI Autopay's ₹15,000 per-debit AFA threshold** is not binding today (Pro yearly is ₹1,999), but any
  plan above it makes "debited automatically" false for that cohort.
- **Mandate consent copy** is drafted, not legally approved — in particular whether it must name the
  entity the bank's own SMS will show.
- **GST on a recurring charge.** `tax` is still 0 and no tax invoice exists (§16.13); autopay makes that
  gap 12× more frequent per customer.
- **`alreadyApplied()` errs toward "already applied"**, so a lost history row on a *renewal* can leave a
  paid cycle un-extended. Pre-existing on the manual path; autopay makes it 12× more likely. Fix: for
  `kind:'renewal'`, trust only the direct `SubscriptionHistory.metadata.paymentId` signal.
