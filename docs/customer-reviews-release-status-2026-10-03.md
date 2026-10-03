# Customers and Reviews release status — October 3, 2026

Customers and email reviews are released for new paid accounts across all plans.
The new-account texting release adds self-service registration, customer keyword
permission, automatic approval reconciliation, and verified Chat add-on billing.
Existing excluded accounts keep their subscriptions and carrier resources.

## Packages

- Chat Only: $15/month, including customer organization and email review requests.
- Chat with review texting: $35/month after approval and successful add-on
  activation, plus a $49 one-time carrier setup fee. The $20 add-on includes
  250 SMS parts per full billing month; its first period is prorated.
- SMS Only: $29/month; SMS + Web Chat: $49/month; Full Suite: $79/month.
  Review texts use these plans' existing SMS allowance after approval.
- New base texting setup is $49. Adding reviews during that setup does not buy
  another number or add the Chat review-texting subscription.
- Existing Price mappings and subscriptions are retained. No existing customer
  subscription is automatically repriced by this release.

## New-account setup

Chat owners complete their business details and number selection in Reviews.
The app generates their stable hosted permission page, collects the activation
fee and submits their actual review program. Following provider approval and
number assignment, the owner sees and accepts the recurring quote.

New higher-tier customers can explicitly include review texts during texting
signup. The application covers customer care and review marketing. The worker
initializes and activates included review accounts after verifying their exact
approved campaign, assigned number and profile keywords; no Reviews page visit
or duplicate provider purchase is necessary.

Customers read the business's hosted disclosure and text REVIEWS themselves.
The signed inbound webhook records consent and confirms it without triggering
an AI response. Owners see the permission record in Customers. Imports, purchases,
START and an owner checkbox do not grant hosted-program review permission.
Preview, campaign confirmation and final sending reservation enforce it.

All new paid accounts receive the Customers and email-review screens. Each owner
still enters their Google review link and chooses customers with permission.
Importing contacts sends nothing. Reminders and completion automation default
to off. Verified account email supplies the initial Reply-To.

## Verification

- Application checks: 2,248 tests across 120 files passed.
- Database checks: 103 suites and 4,072 assertions passed after a guarded fresh
  local migration replay. Test-only database attestation was removed afterward.
- TypeScript, scoped lint and a production build passed.
- Real Stripe TEST checks: 13 application integration cases and eight provider
  contract cases passed, with zero cleanup errors. These cover hosted Checkout,
  signed webhooks, failed payment/recovery, duplicates, cancellation, prorating,
  $35 renewal and returning to the $15 base after cancellation.
- The integrated test found and fixed a Chat billing-family conflict caused by
  review-only phone resources. Exact paid resource ownership preserves Chat's
  base plan without granting SMS/voice base-plan access.
- Migrations 105–111 add the new signup, consent, billing-resource binding,
  permission enforcement, stable URL and automatic initialization behavior.

The owner's scheduled email arrived at 9 AM. Delivery, its Google-review redirect,
click tracking and unsubscribe were verified. The test business was paused again;
general email sending remains enabled. No second customer account was changed.

## Live verification boundary

Automatic provider-resource cleanup remains disabled. Production's shared
resource protection manifest and live cleanup validation are incomplete, and
older generic release runs exist. Do not enable the global remote-release switch
as part of review signup rollout. Review subscription cancellation and paid-term
access controls are tested; provider number/campaign cleanup needs operator
follow-up until its separate production release validation is complete.

Stripe checks use real TEST mode. Carrier approval is simulated only in disposable
local tests. No real carrier application, live add-on purchase or customer SMS was
performed for this release. A new business still needs its own carrier approval
and customer permission before sending. Live delivery and STOP/HELP behavior can
be checked once that business has an approved sender.

The existing SimplAssist CUSTOMER_CARE campaign is not treated as approval for
review marketing. Its sender and profile were not reassigned. Point Guard
University remains outside the rollout.

See [billing evidence](./review-sms-billing-verification-2026-10-03.md),
[release procedures](./customer-reviews-release.md) and
[operations](./review-request-operations.md) for configuration and recovery.
