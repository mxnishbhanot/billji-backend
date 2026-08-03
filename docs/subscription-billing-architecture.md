# BillJi — Subscription, Licensing & Billing Engine · Architecture Reference

> **Status: Phase 0 APPROVED. This document is the official architecture reference.**
> Branch in both repos: `feat/subscription-billing-engine` (off `staging`).
>
> Supersedes the technical section of `../../docs/pricing-plan-v1.md` (different tier
> names/prices, code-config plans, no admin panel). That doc stays useful for pricing
> rationale and India market reasoning only.
>
> **Phases 1 and 2 are implemented** — catalogs, models, seeders, the snapshot/feature/limit
> engines (§12), and the read-only billing API with the stable mobile DTO (§13).

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
| **P3** | Provider layer + Razorpay. `payments/` registry, razorpay + manual providers, checkout/verify, raw-body webhook (§6.2), `SubscriptionPayment`, refunds, receipts. Sandbox-tested | Money can be taken | **High** — most careful phase |
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
