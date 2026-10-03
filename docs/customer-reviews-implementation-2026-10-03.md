# Customers and Reviews implementation — October 3, 2026

The approved feature is implemented in the local workspace. Production remains
unchanged: no deployment, live message, phone purchase, carrier application,
Stripe price creation or subscription change was performed during implementation.
New rollout, sending, provisioning and release controls default to off.

## Delivered

- **Customers:** manual entry, CSV preview/import/export, tags, stages, priority,
  owner-assigned warmth, notes, follow-up dates, addresses with Maps links, saved
  views and completed-service history. Existing captured contacts use the same
  workspace. Anonymous web-chat contacts stay isolated by session.
- **Reviews:** email and approved SMS campaigns with audience previews, scheduling,
  neutral templates, signed links, quota checks, a shared cooldown, one optional
  reminder, unsubscribe and owner stop/completion controls. Clicking the Google
  link stops reminders but does not claim a review was posted.
- **Automation:** future completed services can create a request when the owner
  enables automation and separately records channel permission. Imports and old
  jobs do not trigger messages. Late work expires or needs rescheduling.
- **Operations:** durable delivery queues, worker health checks, verified provider
  callbacks, duplicate protection, uncertain-send recovery and an SMS human-reply
  hold. The review add-on does not grant AI SMS or missed-call handling.
- **Billing:** new package configuration, a $20 Chat review-text add-on, a $49
  carrier setup payment, paid activation, first-period proration, cancellation and
  resource cleanup. Existing accounts can be handled individually.

## Verification

The production build passed with isolated local configuration and dummy provider
credentials. Application TypeScript, the dedicated review-worker TypeScript
configuration and ESLint passed. The final full Vitest run passed **7,659 tests
across 469 files**. Formatting and Git whitespace checks passed.

Database verification used a separate disposable Supabase project,
`SimplAssistReviews`, on ports 56321–56327. Migrations 095–102 were applied as part
of the full migration replay. The existing development stacks were not reset.
The initial replay identified two test-fixture mistakes: reversed positional
delivery-status arguments and a Stripe fixture retaining a partner-only plan.
Both fixtures were corrected and rerun.
The final full pgTAP run passed **3,919 assertions across 94 files**, including
every new customer and review database suite.

Browser verification used fictional businesses and customers with all provider
sending switches disabled. Desktop and mobile flows covered:

- Authenticated Customers and Reviews pages, customer creation and editing,
  address links, notes, tags, priorities and completed-service history.
- CSV preview with valid, duplicate and invalid rows; import preserved existing
  customer fields and added only the intended customer.
- Review settings, personalized neutral email preview, send-window adjustment,
  quota display and the disabled sending control.
- Campaign history, clicked/unsubscribed states and explicit wording that a
  click does not verify a posted review.

Local API checks verified CSV export, idempotent campaign confirmation, exactly
one initial queue record, unsubscribe GET without mutation, unsubscribe POST,
suppressed-recipient exclusion, and a signed Google redirect without following
the external destination. All tested queue records had no provider message ID;
no review request was actually sent.

## Release handoff

Follow [Customers and Reviews release](./customer-reviews-release.md) for the
package table, Stripe configuration, minimal handling of the two existing
accounts and release order. [Review request operations](./review-request-operations.md)
documents worker configuration, pilot controls, sender verification, callbacks,
delivery recovery and resource cleanup.

Live Resend/Telnyx delivery and Stripe checkout, renewal, refund and cancellation
still require a configured provider test/pilot run before public launch. The local
tests cover these integrations through fixtures and mocked provider responses;
they do not establish live carrier approval or deliverability.

First-release limits remain explicit: email replies go to the verified Reply-To
inbox; Google review completion is not automatically detected; moving a Chat
review add-on to another SMS plan uses assisted billing; ambiguous or rejected
carrier setup may require operator reconciliation and cleanup. Custom domains,
social campaigns and a full sales pipeline are separate follow-up work.
