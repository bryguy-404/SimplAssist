# Review texting billing verification — October 3, 2026

The real Stripe TEST integration passed 13 checks against an isolated local Supabase database. The separate provider-contract suite passed eight checks, including clock-driven renewal and cancellation. No live payment, carrier registration, email, or SMS was sent.

## Application integration

`scripts/review-stripe-webhook-e2e.test.ts` completed a $49 hosted Stripe Checkout in the browser. Stripe CLI forwarded the real signed `checkout.session.completed` event to the actual application webhook, which verified the successful PaymentIntent and updated the real local activation ledger. Activation alone did not permit sending.

The same run verified:

- Duplicate signed Checkout delivery preserves one activation; an invalid signature is rejected.
- The actual recurring quote and confirmation code adds only the $20 Chat review-texting item.
- A declined payment and duplicate confirmation leave one unpaid invoice and no review sending access.
- Paying that exact invoice restores access through a real signed invoice webhook.
- Signed subscription updates preserve the paid allowance; a deliberately delayed, test-signed older snapshot cannot erase it.
- The actual cancellation code creates a period-end schedule and preserves already-paid access. An expired local deadline denies access without waiting for another webhook.
- Starter, Growth, and Pro charge no additional review-texting subscription or review activation fee and use their existing SMS pool.
- A local time-limited administrator grant expires correctly.

All created TEST subscriptions were canceled, customers deleted, and prices/products archived. Cleanup reported zero failures. The local database ended with zero businesses, users, review accounts, checkout attempts, and webhook events.

## Regression discovered and fixed

The first integrated run found that generic plan-family inference interpreted a Chat account's review-only number as evidence of an SMS base plan. This caused legitimate subscription and invoice webhooks to fail after review provisioning.

Migration 108 preserves the Chat family only for an explicitly paid, source-bound direct review account whose provider resources match the service-owned bindings. Changed pointers, extra numbers, conflicting resource claims, unpaid setup, and real SMS billing evidence still fail closed. The established paid Chat-to-SMS upgrade path remains intact. Twenty transactional database assertions passed, including cancellation and retained resources after review release.

## Provider contracts

`scripts/review-stripe-release-e2e.mjs` separately passed real Stripe TEST checks for activation amount/idempotency/expiration, a full pre-submission refund, the $15 Chat base plan, prorated $20 add-on billing, payment failure and recovery, $35 renewal, and cancellation that leaves the next Chat invoice at $15.

## Scope and rerunning

Carrier approval is an explicit local fixture in the billing integration. It does not prove carrier approval or live message delivery. The hosted activation Checkout is created from a bound test fixture; the recurring purchase, cancellation, signature verification, webhook processing, and entitlement code are the actual application modules. Included-tier and grant checks use local billing fixtures. Clock-driven renewal is a Stripe provider-contract check, separate from the application webhook run.

The integration is skipped by ordinary Vitest runs. To opt in, provide a Stripe TEST secret, loopback Supabase URL/service-role key, `REVIEW_STRIPE_E2E=1`, `REVIEW_STRIPE_WEBHOOK_E2E=1`, and `REVIEW_STRIPE_E2E_DATABASE_CONTAINER=supabase_db_SimplAssistReviews`, then run:

```sh
npx vitest run scripts/review-stripe-webhook-e2e.test.ts
```

The named disposable review stack must start with current migrations and no businesses. The harness rejects live keys and remote database/Docker targets, writes the hosted payment URL only to a private temporary file, and waits for browser completion with a Stripe test card. It never reads `.env` files. Detailed run evidence belongs in private temporary reports, not in the public repository.

## Production cleanup audit

A read-only production audit during this release found no review accounts or review-release actions. Automatic provider cleanup was not enabled or live-validated. The shared release configuration was disabled, with no configured protected profile/voice identifiers, current verified manifest, dry-run attestation, or completed single-business cleanup test. Five protection rows existed; the two required shared messaging-profile and voice-application entries were absent.

The unrelated resource-release backlog contained one retained protected action and one held unverified action, with no pending, leased, retryable, or blocked actions. Three generic runs remained open: one not-yet-due parked run, one due parked run, and one due blocked run. A fourth run was already in protected hold. This existing state must be reviewed before any global release enablement.

The review worker is an HTTP scheduler. Its effective configuration is the canonical HTTPS application URL, a matching `REVIEWS_WORKER_TOKEN`, and its health-check port. It calls the web application's delivery and lifecycle endpoints. Stripe price IDs, provider credentials, protected identifiers, and all `REVIEWS_SMS_*` execution switches are read in the **web service**, not in the scheduler. Setting `TELNYX_REMOTE_RELEASE_ENABLED` only on the worker does not enable cleanup.

Review cleanup requires both web-side release switches plus the database authorization manifest. The generic `TELNYX_REMOTE_RELEASE_ENABLED` switch also gates registration-recovery mutations; it is not limited to Reviews. The review path itself can only unassign its exact number, release that number, and deactivate its exact campaign. It cannot delete brands, messaging profiles, or voice applications. Its authorization rejects platform identifiers, protected businesses/resources, owner-alert resources, cross-business claims, shared higher-tier resources, active upgrades, and resources whose paid term has not ended.

The local configured shared profile matched the production owner-alert profile. A numeric shared voice-application candidate existed locally, but the protected phone's database bindings did not independently confirm it. Candidate identifiers were saved only in private audit evidence. The safe next step is to verify both current production/provider bindings, add only their exact protection entries, and retain disabled cleanup while completing the actual manifest review, dry run, and a scoped disposable-account cleanup test. Adding protection entries alone does not satisfy those prerequisites. Until then, cancellation can stop paid review access, but provider-resource cleanup remains an operator task and must not be described as fully live-verified.
