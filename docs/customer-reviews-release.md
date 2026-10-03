# Customers and Reviews release

This implements the approved customer workspace and review-request feature. It
does not deploy the app, change live Stripe subscriptions, buy phone numbers, or
send customer messages. New capabilities and outbound workers default to off.

## Product behavior

- **Customers:** manual entry, CSV preview/import and export, tags, customer
  stage, priority, manual warmth, notes, follow-up dates, a service address with
  a Maps link, saved views and service history. Captured web-chat identities stay
  tied to their anonymous session; a supplied email is not proof of identity.
- **Reviews:** neutral email or approved SMS campaigns, a frozen audience preview,
  scheduling, one optional reminder four days after acceptance, shared cooldown,
  suppression and owner controls. A tracked click stops reminders but never claims
  that a Google review was posted. Every recipient gets the same review opportunity.
- **Completion automation:** opt-in for future completed service events with
  separately recorded channel permission. It does not scan historical jobs or
  automatically message an imported list. Default delivery is next day at 10 AM
  in the recorded recipient or business timezone.
- **Texting:** the Chat review add-on includes review requests and human replies
  to review conversations. AI SMS, missed-call automation and unrelated manual
  texting still require a base plan that includes those capabilities.

## Package configuration

| Package                  | Monthly USD | Review email allowance | SMS allowance                      |
| ------------------------ | ----------: | ---------------------: | ---------------------------------- |
| Chat Only                |         $15 |                    500 | None                               |
| Chat Only + review texts |   $35 total |                    500 | 250 shared incoming/outgoing parts |
| Starter / SMS Only       |         $29 |                    500 | Existing 500-part pool             |
| Growth / SMS + Web Chat  |         $49 |                  1,000 | Existing 1,500-part pool           |
| Pro / Full Suite         |         $79 |                  2,000 | Existing 2,500-part pool           |

An email allowance counts invitations and reminders. Owner test messages and
Reply-To verification emails have separate daily and per-minute rate limits.
SMS is measured in message parts, not recipients: long messages, reminders and
replies consume the same pool.
The Chat add-on first partial billing period prorates both its charge and its
allowance. It renews on the base subscription's existing billing date.

New SMS setup is $49 for one carrier application. A refund is available before
paid provider work starts. Carrier rejection or an uncertain provider result goes
to support for reconciliation and any separately quoted resubmission; it never
silently buys repeated registrations. Recurring review texting starts only after
provider readiness and verified payment. These are launch package prices, not a
guarantee of profit at arbitrary usage.

Set `NEXT_PUBLIC_CUSTOMER_REVIEWS_PRICING_ENABLED=1` at **build time** only after
new Stripe Prices and review operations are ready. Configure the four existing
`STRIPE_PRICE_*` plan variables with new monthly USD Prices. Configure
`STRIPE_PRICE_REVIEW_SMS` as a licensed $20 monthly Price and
`STRIPE_PRICE_REVIEW_SMS_ACTIVATION` as a $49 one-time Price. The generic
`STRIPE_PRICE_SETUP_FEE` must also use the new $49 setup Price when releasing the
new packages. Do not reuse a legacy plan Price ID for a new amount.

The two existing accounts can be handled individually. Optional
`STRIPE_LEGACY_PRICE_CHAT_ONLY`, `STRIPE_LEGACY_PRICE_SMS_ONLY`,
`STRIPE_LEGACY_PRICE_SMS_AND_CHAT`, and `STRIPE_LEGACY_PRICE_FULL` allow explicit
recognition of retained subscriptions. No automatic subscription migration or
large grandfathering program is required. Partner-managed and comped accounts
use their existing entitlement source and an explicit, time-bounded SMS grant;
they do not automatically create a direct Stripe subscription.

## Release sequence

1. Apply migrations 095–111 in a disposable environment and run the guarded
   database suite, unit tests, type checking, and customer/review browser flows.
2. Configure the verified review email sender, signed webhook, link secret and
   dedicated Railway worker described in [review-request-operations.md](./review-request-operations.md).
3. Expose the Customers screen to selected businesses with
   `CUSTOMERS_WORKSPACE_BUSINESS_IDS` (comma-separated UUIDs), or use
   `CUSTOMERS_WORKSPACE_ENABLED=1` for the general release. For all new accounts,
   set `REVIEWS_EMAIL_PILOT_BUSINESS_IDS=*` and database
   `review_email_control.all_businesses_enabled=true`. Preserve accounts that
   are intentionally outside this rollout with matching
   `CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS` and database
   `excluded_business_ids`. Exclusions override wildcard and explicit pilot
   access. Neither admission control enables sending by itself.
4. Complete an owner-only pilot with outbound sending initially off. Verify
   setup, imports, permissions, preview, scheduling, stopping, quota handling,
   callbacks, and unsubscribe before enabling email sending for the pilot.
5. For SMS, obtain approval for the actual review-request marketing use case.
   An existing customer-care campaign is not assumed to cover review campaigns.
   Set `REVIEWS_SMS_PROVISIONING_ENABLED=1` only when paid provider work should
   run. Enable SMS sending only after the sender, consent flow and payment are
   verified. Keep shared/platform/owner-alert senders protected.
   Verify the actual profile's STOP/START/HELP responders and that the approved
   campaign declares embedded links. Review-owned provisioning configures these
   responders; existing profiles are inspected without rewriting their responses.
   An existing customer-care campaign needs a newly approved appropriate campaign,
   not just an administrator override. Preserve its working number while the
   replacement application is pending.
6. Test the $49 activation, $20 add-on, partial-period quote, renewal, failed
   payment, cancellation and pre-submission refund in Stripe test mode. Validate
   representative AI and voice costs with the owner before publicly releasing
   Growth and Pro at these prices; their existing AI entitlements remain intact.
   Then rebuild with the public package flag and matching production Price IDs.
7. Enable `REVIEWS_SMS_RELEASE_ENABLED=1` together with the existing
   `TELNYX_REMOTE_RELEASE_ENABLED=1` only after verifying the release manifest and
   protected resources. Cancellation preserves service through the paid term;
   an approved but unpaid dedicated sender has a seven-day activation window.

The release worker operates independently of the message sending kill switch.
Disabling outbound messages must not leave paid resources rented indefinitely.
Uncertain destructive results require reconciliation before another attempt.

The guarded `scripts/review-stripe-release-e2e.mjs` harness exercises real Stripe
test-mode billing contracts with fresh disposable resources and a read-only
local database schema preflight. It does not certify hosted Checkout completion,
application webhook/entitlement synchronization, or carrier delivery. Never pass
production credentials or a remote database to it.

The opt-in `scripts/review-stripe-webhook-e2e.test.ts` harness additionally uses
hosted Stripe TEST Checkout, Stripe CLI's signed forwarding, the actual webhook
route, and a disposable local database. It verifies failed-payment recovery,
duplicate events, recurring entitlement, and cancellation. Provider approval is
simulated only in that isolated database; this does not certify carrier delivery.

## New-account review texting

Chat customers save business verification details and choose a dedicated local
number in Reviews. The app creates their stable public consent URL, collects the
$49 activation payment, and registers the review program. After provider approval
and number assignment, the owner reviews the prorated $20/month quote and activates
it. A failed payment cannot enable sending. These resources remain associated
with the Chat subscription without granting the base SMS/voice plan.

New SMS, SMS + Chat, and Full customers can choose review texts on the SMS-use-case
step. Their application declares both customer care and review marketing, including
review links. The worker initializes their included review account and enables
it only after it verifies the exact approved campaign, profile keywords and assigned
number. This uses the existing plan allowance and does not buy another number or
charge the Chat add-on. Existing filings are not silently reclassified.

Each participating business receives `/c/<business-slug>/review-texts`. Customers
read the disclosure and send `REVIEWS` from their phone to that business's assigned
number. The signed inbound webhook records versioned consent, sends an idempotent
confirmation, and consumes the keyword before normal AI replies. Customers see
STOP/HELP information and linked privacy/terms. Sending START alone restores
messaging but does not subscribe to reviews.

Owners see the permission record in Customers and can withdraw permission.
For this hosted program, importing a phone or checking an owner attestation cannot
replace customer-originated permission. Preview, campaign confirmation and the
final sending reservation enforce it. A review request still requires completed
work and an owner-created campaign or explicitly enabled completion automation.

## Deliberately limited first release

- Email replies arrive in the verified Reply-To inbox; the app does not ingest them.
- Google-link clicks are observable; a posted review is not automatically verified.
- Higher-tier texting uses its existing allowance and requires explicit approval
  for the review use case before enabling review campaigns.
- Changing from a Chat review add-on to another SMS base plan uses assisted billing
  while the existing upgrade flow rejects unsupported multi-item subscriptions.
- Custom sender domains, social campaigns, review-platform imports and a full CRM
  sales pipeline remain separate follow-up work.

Do not paste provider keys or customer data into release evidence. Keep final
verification results and any known limitations in the implementation report.
