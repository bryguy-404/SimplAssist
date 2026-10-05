# Review texting conversion verification — October 4, 2026

The implemented conversion supports an active $15 Chat subscription with its paid $20 review-texting item moving to Growth at $49/month. It replaces the two Stripe items with one Growth item, retains the current billing date, credits both unused source portions, and charges no new activation fee. Full remains the subsequent Growth-to-Full step.

## Executed checks

- `src/lib/stripe/reviewConversion.server.test.ts` and the four related billing, rollout, and synchronization suites: **94 tests passed**. These cover exact source receipts, invoice ownership, declined payments, response-loss recovery, stale events, cancellation, a new quote after a voided invoice, and rejection of unsupported invoice composition before payment.
- `supabase/tests/database/114_review_texting_conversion_billing.test.sql`: **46 assertions passed** in a transaction rolled back on the isolated `SimplAssistReviews` local database. Coverage includes the atomic family/plan/included-review change, one 1,500-part allowance with usage retained, historical $25/$49 activation credit, concurrent cancellation, replay fences, and owner cleanup. Cleanup removes review/provider personal information while retaining the paid conversion and immutable historical receipt references.
- `scripts/review-conversion-stripe-e2e.test.ts`: **9 checkpoints passed** against the real Stripe TEST API, Stripe CLI-signed requests to the application's actual webhook route, and the isolated local database. The final run completed in 77.92 seconds.
- `scripts/review-stripe-release-e2e.mjs`: **8 Stripe TEST API-contract checks passed**, including a $25 Checkout amount, a real $25 test PaymentIntent, an exactly-once full $25 refund, $35 review-addon renewal, and return to a $15 Chat renewal after addon cancellation.
- `scripts/review-conversion-preview-stripe.test.ts`: **4 additional Stripe TEST contract checks passed** in 10.46 seconds. A real clean preview contains the expected three prorations. A real unrelated pending invoice item creates a fourth line and is rejected; a real customer credit changes the amount due without adding a line and is also rejected. These checks do not mutate the subscription or use a database. Their disposable resources were cleaned up without errors.

All three real Stripe runs finished with **zero cleanup errors**. Their test subscriptions/customers were removed or canceled and their test catalog resources archived. The local database was verified empty of businesses, users, review accounts, and upgrade operations before being handed to browser verification.

## Real conversion behavior verified

1. A declined prorated payment leaves both original subscription items and direct review-texting access in place.
2. Paying that exact invoice causes the signed application webhook to activate Growth and included reviews atomically. The review item disappears and its separate 250-part allowance is not added to Growth's 1,500-part cap; existing usage remains.
3. Duplicate signed deliveries and a delayed two-item Chat snapshot cannot restore the old plan or duplicate the charge.
4. Advancing the real Stripe test clock produces a $49 renewal with no $20 addon or second activation fee. Later cancellation reaches the application and does not restore access.
5. A real SCA payment remains unpaid and can be canceled by conclusively voiding its exact invoice. The same approved-number handoff can be reopened with the original historical $49 activation receipt.
6. After that void, another quote succeeds using the paid current-period source receipts. Stripe reports the new PaymentIntent as `requires_action`; paying its exact invoice with a valid replacement payment method completes the conversion through the signed webhook without a second setup charge.
7. Early/out-of-order signed deliveries remain retryable and recover from current provider state.
8. Both initial quoting and the final pre-payment preview require the exact source/target proration lines and an amount due equal to their signed sum. Extra charges, truncated lines, and unsupported tax or balance-credit adjustments fail before the payment operation is confirmed or Stripe is updated.

## Scope of this evidence

The conversion harness uses explicit local fixtures for the prior activation receipt and completed carrier handoff. Its subscription changes, invoice lines, payment failures, SCA status, payment recovery, test-clock renewals, and signed application webhook processing are real Stripe TEST behavior.

The $25 activation contract test creates and expires hosted Checkout, then verifies a separate real test PaymentIntent and refund. It does **not** complete the hosted activation page or prove a new $25 activation through the application's Checkout-completed webhook. Likewise, SCA recovery used a replacement payment method; it did not automate the browser's 3DS challenge.

No live card charges, customer messages, Telnyx filings, number assignments, or production database changes were made by these tests. Carrier approval and live number handoff remain a separately gated pilot. Tests do not authorize enabling global resource release.

The reproducible opt-in harness requires `REVIEW_CONVERSION_STRIPE_E2E=1`, a Stripe `sk_test_` key, and the dedicated loopback Supabase test configuration. It rejects remote databases and non-test Stripe objects. It also requires an empty dedicated database and cleans only resources created by its own run. Reports were saved privately under `/private/tmp`; no credentials or customer identifiers are included here.
