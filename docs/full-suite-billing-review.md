# Full Suite billing implementation review

Scope: Phase 2 of the [public launch plan](full-suite-public-launch-plan.md). Full sales remain closed at this checkpoint. No provider objects or production data were changed by this implementation work.

## Behavior

- SMS acquisition and canceled-account rejoining use one durable operation per business. Customer creation and Checkout retries reuse the operation's original idempotency keys and request parameters. An active or uncertain subscription cannot trigger a second acquisition.
- Existing SMS subscribers review an authoritative Stripe invoice preview before confirming an upgrade. Confirmation uses the stored proration date, the same monthly anchor, `pending_if_incomplete` and `always_invoice`. Canonical access changes only after a verified paid invoice, including a legitimate zero-due paid invoice. The original payment time controls proportional Full voice minutes.
- Plan downgrades use a schedule at renewal. The current paid tier remains available until then. Supported existing discounts, tax configuration, payment method and invoice settings are carried into both phases; unsupported schedule features fail closed.
- SMS counters and selected overage preferences survive a plan change. A paid same-cycle upgrade raises the included cap without resetting consumption. Setup-fee proof is retained per business, including a legacy Checkout that finishes after the authority table is introduced.
- Read-only status reconciliation and an explicit recovery action handle provider-success/local-response-loss windows. Signed Checkout completion can bind a session whose create response was lost. Unknown requests older than the bounded idempotency-retry window remain blocked for support review rather than issuing another payment request.
- Current-source and owner checks are repeated under the business lock. A paid replacement requires verified terminal evidence for the old subscription. Historical source events cannot replace the current subscription.
- Billing authority survives the existing PII scrub and cancellation queue. The existing cleanup completion checks must succeed, with exact applied cancellation or proven terminal replacement evidence, before billing operations/accounts are purged. The business tombstone remains. Expected late callbacks can no-op only for that exact scrubbed owner-null tombstone with no canonical subscription; unknown operations on live businesses still fail closed.
- Recurring voice allowance requires a paid invoice line for the exact monthly subscription-item interval. Active status alone, an unrelated invoice line or a proration invoice does not create a renewal allowance. The paid-operation hook handles upgrade proration separately.

## Verification

- Focused application regression: **9 files / 291 tests passed**. Coverage includes preview/confirmation, unpaid and zero-due invoices, foreign source rejection, preserved renewal settings, setup-fee omission, lost responses, original idempotency retries, expired retry cutoff, phase-boundary cancellation, late tombstone callbacks, request serialization and renewal-payment evidence.
- Exact final migration replay and complete isolated database suite: **75 files / 3,296 assertions passed**, reported by the schema test owner. This includes the actual scrub → queued cancellation → applied cancellation → cleanup completion sequence, source replacement, paid enrollment, retained SMS consumption and immutable allowance replay. These are local synthetic fixtures.
- Two independent sensitive billing/deletion reviews completed. The first found late legacy fee-proof and cleanup-ordering defects; both were fixed and received a second review. The second review also checked callback handling, immutable old-source evidence, Checkout crash binding and schedule-release recovery, and found no remaining blocker.
- Separate billing Checkout contention was not simulated with parallel provider requests. Database locking, the unique open-operation constraint, stable operation keys and replay tests are the duplicate-operation controls.

## Limits and release conditions

The owner waived additional real Stripe test-mode transactions. The new proration, canceled rejoin, payment-failure and schedule lifecycle has **not** been exercised against Stripe in this batch; mocks and local SQL checks do not prove provider execution. No real subscription or charge was initiated.

The read-only launch inventory found zero open legacy SMS Checkout or legacy rejoin sessions. Repeat that inventory immediately before migration: an older unmarked rejoin Checkout must not be stranded by the new source guard. The existing portal's subscription updates remain disabled; plan changes use the explicit reviewed flow. Public purchase UI and final sales activation remain root-owned release checks.
