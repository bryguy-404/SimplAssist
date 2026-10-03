# Customers and Reviews release status — October 3, 2026

Customers and email reviews are released for new paid accounts across all plans.
Existing non-pilot accounts remain excluded; their subscriptions and carrier
resources are unchanged. Review texting is not publicly enabled yet.

## Pricing and rollout

- New monthly prices: Chat Only $15, SMS Only $29, SMS + Web Chat $49, Full Suite
  $79. New SMS setup is $49; Chat Only has no setup fee.
- Stripe has the $20/month review-text add-on and $49 activation Prices ready.
  The $35 Chat-plus-review-text package is not available for activation while
  its feature, sending and paid-provisioning controls remain off.
- Existing plan Prices are retained under the explicit legacy mappings. The
  existing live subscription was verified unchanged; creating new Prices did
  not migrate it.
- Application wildcard admission and database general admission are enabled
  with matching existing-account exclusions. Newly created businesses do not
  need to be added to a pilot allowlist.
- Owners still provide their Google review link and recipient permission.
  Verified account email supplies the initial Reply-To. Importing contacts does
  not send messages; reminders and completion automation default to off.
- Migrations 095–104 are applied. Migration 103/104 contents were checked against
  the committed source, and Point Guard University remains outside the rollout.

## Verification

- 96 disposable database suites / 3,963 assertions passed.
- Shared focused application run: 465 tests across 30 files passed; the final
  keyword/provisioning ownership regressions also passed.
- Additional SMS API and Stripe-webhook coverage: 86 tests across two files
  passed, including activation/expiration routing, authorization and retries.
- Full TypeScript checking, focused lint and a production build with the new
  pricing flag passed. The production release passed its health check.
- Pricing copy now explains Customers and email reviews alongside the new
  amounts. The comparison uses the shared per-plan allowances and passed 14
  focused tests, lint and TypeScript checking.
- Real Stripe TEST API verified eight provider contracts: activation Checkout,
  activation payment/refund, the $15 base, prorated $20 add-on, duplicate retries,
  failed payment/recovery, $35 renewal and cancellation followed by $15 renewal.
  All disposable Stripe resources were cleaned up with zero cleanup failures.
- These checks do not claim a complete hosted Checkout → application webhook →
  database-entitlement integration, or actual carrier delivery.

## Scheduled owner email verification

The two earlier owner-preview emails were delivered exactly once. A normal
customer-style email remains scheduled solely to the owner's test contact for
October 3, 2026 at 9 AM Eastern, with real signed review/unsubscribe links and no
reminder. It was verified pending with zero attempts after rollout.

Do not follow its Google link before delivery: doing so stops the pending
request. The 9:05 AM follow-up verifies delivery, redirect/click and unsubscribe,
then pauses only the pilot business. It must preserve the global email rollout
and dispatch controls. Private operational identifiers remain outside this
committed report.

## Review texting still requires approval

The live SimplAssist campaign is approved for CUSTOMER_CARE, has no MARKETING
sub-usecase, and does not declare embedded links. It cannot grant review-text
access. Its existing campaign, sender and profile were inspected without mutation.

SMS readiness now verifies embedded-link approval and actual STOP/START/HELP
rules. New review-owned profiles receive guarded, retry-safe keyword provisioning;
existing profiles are read-only and unsupported aliases fail closed. HELP/INFO
cannot fall through to AI replies, and STOP ALL is handled consistently.

The remaining pilot steps are to obtain the owner's test number and actual
review-text opt-in method/evidence, prepare a new appropriate campaign using the
existing brand, obtain carrier approval, then coordinate the number assignment
and run live delivery, replies, HELP, STOP/START and click/reminder-stop checks.
Keep current texting working while replacement approval is pending. No carrier
application, sender reassignment, customer charge or review SMS was performed.

Normal higher-tier signup still files customer-care campaigns. Review texting
must remain disabled until mixed-purpose signup/disclosures and per-business
review approval are completed; new plan purchase alone does not authorize it.

See [the release guide](./customer-reviews-release.md) and
[operations](./review-request-operations.md) for controls and recovery.
