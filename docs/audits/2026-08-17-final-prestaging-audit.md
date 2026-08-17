# FINAL INDEPENDENT PRE-STAGING AUDIT

Scope: BillJi Customer Credit implementation (settlement claims, credit application, invoice/credit-note cancellation, ledger, customer balance). Audit only — no code changed.

## Verdict

**NOT READY FOR STAGING**

One credible cancellation-race / financial-correctness gap found (F-1). Everything else inspected (settlement claim/release, rehydration, ledger compensation bounds, idempotency, tenant scoping, transaction fail-closed behavior) held up under adversarial review.

## 1. Executive Summary

- Invoice cancellation (`cancelInvoiceWorkflow`) is correctly hardened: atomic close-first CAS (`closeInvoiceForCancellation`), re-check after transition, bounded 3-pass reversal sweep. Solid.
- Credit-note / quotation / challan cancellation (`cancelDocumentWorkflow`) was **not** given the same treatment: it reads the document, checks `appliedAmount`, mutates in memory, and `.save()`s at the end — the exact pattern the invoice path's own comments say was replaced because it left the document reporting `issued` for the whole unwind (**F-1**).
- Under a real MongoDB multi-document transaction this specific race self-heals via write-conflict + automatic retry — but only if the deployment is genuinely on a replica set and `NODE_ENV` is exactly `production`/`staging`/anything not in `{development,test}`. The safety is implicit and load-bearing on transaction machinery nobody asserted for this path, not on an explicit guard.
- `settledAmount` guard design (compare-and-set claim/release, rehydration-raise-only, `pre('save')` hook stripping accidental `$set`) is correct and self-consistent everywhere it's used.
- Transactionless fallback is fail-closed: only literal `NODE_ENV ∈ {development,test}` may skip a session; read live from `process.env`, never through the `env.js` default. PASS.
- Multi-invoice payment cancellation (cross-invoice allocation refund, unapplied-credit withdrawal, bounded cash-debit compensation) is careful and internally consistent — traced the ₹300-spendable-vs-refundable scenario by hand, money never double-counted.
- `Payment.refundableAmount` is only populated for the cross-invoice and unapplied-credit cases, never for a payment's own direct allocation on the invoice being cancelled (only `refundStatus` flips). Ledger correctness is unaffected (P3, reporting gap only).
- Idempotency middleware (unique-index race, hash-mismatch rejection, stale-lock reclaim, response persisted before bytes leave) is sound.
- Tenant isolation: every query/claim touched in this trace is scoped by `business`. No cross-business path found.

## 2. Findings

### F-1
- **Severity:** P1 — serious financial correctness risk
- **File:** `backend/src/modules/documents/service.js`
- **Function:** `cancelDocumentWorkflow`
- **Exact problem:** Cancellation of a `credit_note` (also quotation/challan) loads the document, evaluates the "has live applications" guard (`document.appliedAmount > 0`) against that in-memory read, then later does `document.documentStatus = 'cancelled'; ...; await document.save({ session })`. There is no atomic compare-and-set that closes the document's status before the guard/reversal work runs — unlike `cancelInvoiceWorkflow`, which was explicitly rewritten (see its own comments) because this exact shape left a window where a concurrent settlement could pass a stale status check.
- **Why it matters:** A concurrent `applyCreditWorkflow` claiming from this same credit note (`claimCreditFromNote`, `documentStatus: 'issued'` predicate) can commit between the cancellation's read and its `save()`. Mongoose's diff-based `save()` only `$set`s fields actually reassigned in JS, so it won't clobber the concurrently-written `appliedAmount` — but it *will* still `$set documentStatus: 'cancelled'` over a note that, by the time the save lands, already backs a live settlement allocation. Result: a cancelled credit note with `appliedAmount > 0` and a live `SettlementAllocation` still reducing an invoice's balance, while `creditSourcesForCustomer`/`customerBalanceTotals` exclude cancelled notes from `creditIssued` — the credit that's still settling an invoice has vanished from the customer's credit pool. Cancellation also unconditionally reverses the note's *original* ledger pair (full `customer_credits` credit), while the credit application already posted its own `customer_credits` debit for the applied portion — same liability discharged/reversed twice, i.e. `customer_credits` goes wrong by the applied amount and `sum(debits) != sum(credits)` for the pair of events.
- **Reproduction/interleaving:** (1) Load credit note (issued, appliedAmount=0) in cancel workflow. (2) Concurrently, `applyCreditWorkflow` claims ₹1,000 from the same note via `claimCreditFromNote`, writes the allocation and its ledger pair, commits. (3) Cancel workflow's stale-read guard already passed at step 1; it proceeds to `document.save()`, setting `documentStatus: 'cancelled'`, and unwinds the *original* ledger rows for the full note amount.
- **Current protection:** None explicit for this path. Only whatever MongoDB's document-level transaction conflict detection provides.
- **Why protection is/isn't sufficient:** Under a genuine multi-document transaction (replica set + `withTransaction`), any ordering of the two operations produces a write conflict on the shared document, and `session.withTransaction()`'s automatic retry re-executes the *entire* callback from a fresh read — which does correctly re-evaluate the guard and block the loser. So on a correctly configured staging/production deployment (verified fail-closed via `transaction.js`'s `NODE_ENV` allow-list, F-1 does not fire today. But the safety is entirely borrowed from transaction retry semantics that nothing in this file asserts, tests, or documents for this path — unlike the invoice path, which was deliberately hardened to hold even without a session. Any of the following turns this into a live P0: the no-session dev/test fallback (already reachable by construction whenever `NODE_ENV` is `development`/`test` — i.e., exactly the environment these tests plausibly run in), a future change that drops the transaction wrapper, or a retry-exhaustion / non-transient-error edge case that isn't a true `TransientTransactionError`. A cancellation-safety invariant that holds only by relying on a different subsystem's retry behavior, undocumented and unenforced here, is not the same guarantee the invoice path was given, and per this audit's own instructions a credible cancellation race must fail the build regardless of how narrow the window is in the common case.
- **Fix direction (not applied — audit only):** Give `cancelDocumentWorkflow` the same atomic close-first CAS `cancelInvoiceWorkflow` uses (a `findOneAndUpdate` that transitions `documentStatus` only when still `issued`/live, combined with a post-transition re-check of `appliedAmount`), so the guarantee doesn't depend on transaction retry semantics holding.

### F-2
- **Severity:** P3 — cosmetic / incomplete field, not a correctness issue
- **File:** `backend/src/modules/payments/repository.js` / `backend/src/modules/invoices/service.js`
- **Function:** `withdrawUnappliedCreditForInvoice`, `refundCrossInvoiceAllocationsForInvoice`, `reverseLedgerForInvoice`
- **Exact problem:** `Payment.refundableAmount` is only incremented for (a) cross-invoice allocations refunded on a non-last invoice's cancellation, and (b) unapplied credit withdrawn on the payment's own invoice cancellation. A payment's *direct* allocation to the invoice actually being cancelled never moves out of `allocatedAmount` into `refundableAmount` — only `refundStatus` flips to `pending`.
- **Why it matters:** The export manifest's `refundableAmount` column under-reports the cash owed back for the common single-invoice-cancellation case (shows less than the true refund, sometimes 0, even though `refundStatus: 'pending'` correctly flags it). Ledger and customer-balance math are unaffected — `reverseLedgerForInvoice` compensates the cash debit correctly regardless of this field.
- **Reproduction/interleaving:** Cancel a plain single-invoice, single-payment invoice. `refundStatus` → `pending`, `allocatedAmount` unchanged, `refundableAmount` stays 0.
- **Current protection:** None; not a guarded invariant, just an incompletely populated field.
- **Why protection is/isn't sufficient:** Doesn't move or lose money; only affects a reporting column. Not a blocker, but should be reconciled before anyone builds a refund-processing feature that trusts `refundableAmount` as the source of truth for "how much cash to hand back."

## 3. Eight Invariants

| Invariant | PASS/FAIL | Evidence |
|---|---|---|
| settledAmount <= total | PASS | `claimSettlementOnInvoice` (`repository.js:163`) is one `findOneAndUpdate` with `settledAmount: {$lte: total-amount}` + `$inc`; ceiling computed from immutable `invoice.total` before the write. |
| settledAmount == live allocations | PASS | `settledAmount` moved only by claim/release `$inc`; `pre('save')` hook (`SalesDocument.js:218`) strips any accidental modification from a generic `.save()`. `paidAmount/creditApplied/balanceDue` recomputed from `allocationTotalsForInvoice` on every settling write. No other writer found repo-wide. |
| cancelled invoice cannot settle | PASS | `closeInvoiceForCancellation` atomic CAS commits `documentStatus:'cancelled'` before any reversal; `claimSettlementOnInvoice`'s own predicate excludes cancelled/void in the same op, so no ordering lets a claim land after cancellation, transaction or not. |
| cancelled money represented once | PASS (invoice path); **at risk for credit notes, see F-1** | Cross-invoice cash / unapplied credit / direct allocation are handled through disjoint, CAS-guarded counters (`allocatedAmount` / `unappliedAmount` / `refundableAmount`), traced by hand for the ₹300 spendable-vs-refundable case with no overlap. |
| source cannot be consumed without allocation | PASS | `claimCreditFromNote`/`claimCreditFromPayment` claim before the allocation is created; on failure (no session) allocations already written are deleted and every claim released (`applyCreditWorkflow` catch block). |
| allocation cannot exist without source | PASS | Same ordering — claim always precedes `createSettlementAllocation`; no path creates an allocation first. |
| transaction fallback fail-closed | PASS | `transaction.js`: `TRANSACTIONLESS_ENVIRONMENTS = {'development','test'}`, read live from `process.env.NODE_ENV` (not `env.js`'s defaulted value), any other value throws instead of falling back. |
| legacy settledAmount safe | PASS | `rehydrateSettlementBaseline` only raises via CAS on the exact previously-read value (or on "missing"); bounded 3-attempt retry; even on exhaustion the subsequent `claimSettlementOnInvoice` CAS reads live DB state, not the stale in-memory value, so it self-heals. |

## 4. Concurrency Matrix

| Race | Safe? | Why |
|---|---|---|
| payment vs payment | Yes | Both claim `settledAmount` via CAS; second claim's predicate is evaluated against the first's already-applied `$inc`. |
| payment vs credit | Yes | Same shared `settledAmount` counter serializes both regardless of funding source. |
| credit vs credit | Yes | Source-side CAS (`claimCreditFromNote`/`claimCreditFromPayment`) stops the same credit unit being claimed twice; invoice-side `settledAmount` CAS stops two different credits over-filling one invoice. |
| payment vs cancellation | Yes | `closeInvoiceForCancellation` CAS + `claimSettlementOnInvoice`'s cancelled-exclusion predicate in one op. |
| credit vs cancellation (invoice) | Yes | Same as above — invoice-level cancellation is hardened. |
| credit note vs invoice cancellation | Yes | `liveCreditNoteCountForInvoice` checked both before and after the atomic transition; re-check catches a note raised in the race window. |
| credit-note cancellation vs application | **No — F-1** | `cancelDocumentWorkflow` has no atomic close-first transition; safety is borrowed entirely from MongoDB transaction write-conflict + retry, unasserted and untested for this path. |
| customer (multi-invoice) payment vs cancellation | Yes | Traced by hand: cross-invoice refund, unapplied-credit withdrawal and direct-invoice refund-pending use disjoint counters; cash-debit compensation bounded per-payment via a running budget map, never double-compensated. |

## 5. Ledger Reconciliation

1. **Normal payment** (₹1,000 invoice, ₹1,000 cash): debit cash 1,000 / credit A/R 1,000. Net 0.
2. **Overpayment** (₹1,000 invoice, ₹1,200 cash): debit cash 1,200 / credit A/R 1,000 + credit customer_credits 200. Net 0.
3. **Credit note** (₹1,000 invoice credited): debit sales 1,000 / credit customer_credits 1,000. Net 0. (A/R untouched — correct, debt isn't settled yet.)
4. **Credit application** (₹1,000 from note to invoice): debit customer_credits 1,000 / credit A/R 1,000. Net 0.
5. **Credit reversal**: debit A/R 1,000 / credit customer_credits 1,000 (mirror of #4). Net 0.
6. **Single-invoice cancellation** (after #1): reversal mirrors credit A/R→debit 1,000 / cash debit→credit 1,000 (bounded to this invoice's live-allocation + withdrawn share). Net 0. Payment flips to `refundStatus: pending`.
7. **Non-last multi-invoice cancellation**: cross-invoice sweep reverses A/R for that invoice's share only, moves that share `allocatedAmount → refundableAmount` on the shared payment, compensates only that fraction of the one cash-debit row (bounded by the running `outstanding` budget). Net 0 for the compensated slice; the rest of the receipt's ledger rows (for the invoice still standing) are untouched.
8. **Last multi-invoice cancellation**: unapplied credit withdrawn first (bounded compensation of the `customer_credits` row to exactly what was withdrawn — not the full original row, since part may already be spent elsewhere and discharged by that application's own debit), then the invoice's own share reversed the same way as #6. Net 0, no double-compensation of credit already consumed.

All eight reconcile to net 0 given the current code. (F-1's failure mode is exactly a case where #4/#5's mirrored pair intersects with a *second*, unrelated cancellation reversal of the note's original issuance entry — the one scenario that does **not** reconcile, because the applied portion gets debited from `customer_credits` twice.)

## 6. Existing Data

| Legacy state | Outcome |
|---|---|
| `settledAmount` missing | `rehydrateSettlementBaseline` treats `undefined`/`null` as "missing", CAS-sets to the live allocation total before the first claim is measured. |
| `settledAmount` = 0, no allocations | No-op (already correct); first claim proceeds normally. |
| `settledAmount` correct | `stored >= live` short-circuits; no write. |
| `settledAmount` stale but lower | Raised to `live` via CAS on the exact stale value read. |
| `settledAmount` stale but higher | Left alone (rehydration only raises) — this is the value a concurrent claim already reserved capacity against, so lowering it would be the over-settlement the guard exists to prevent. |

## 7. Test Quality

Not exhaustively re-run in this audit (audit-only, no execution required by the brief beyond static review), but by inspection:

- `settlementNoTransaction.test.js` / `transactionFallback.test.js` exist specifically to exercise the no-session path — the file names and the `TRANSACTIONLESS_ENVIRONMENTS` check line up, and removing the CAS predicates in `repository.js` would make their balance assertions fail (they assert on `settledAmount`/allocation totals after simulated concurrent calls, not on timing). These read as genuine invariant tests, not timing-dependent ones.
- No test file specifically exercises **credit-note cancellation racing a credit application** (the F-1 scenario) — `creditLifecycle.test.js`/`creditApplication.test.js` were not traced line-by-line in this pass, but no test name suggests this interleaving is covered, and the code path itself has no guard for a test to exercise the failure against.

## 8. Remaining Risks

- F-1 (credit-note cancellation race), scoped above.
- F-2 (`refundableAmount` reporting gap for direct-allocation cancellations).
- Ledger correctness for F-1's failure mode was reasoned through code, not executed against a live concurrent test — recommend adding one alongside the fix.

## 9. Final Decision

**NOT READY FOR STAGING** — fix F-1 (give `cancelDocumentWorkflow` the same atomic close-first guard `cancelInvoiceWorkflow` already has) before push. Everything else audited holds.
