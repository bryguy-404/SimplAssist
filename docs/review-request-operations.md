# Review request operations

The new review system ships disabled. Migrations 095–102 create the customer,
email, shared SMS safety, activation, SMS delivery and completion-automation
state. Applying migrations does not send anything or enable a pilot. Configure
and verify a disposable environment before enabling any production business.

## Rollout controls

- `REVIEWS_EMAIL_ENABLED=1` and comma-separated
  `REVIEWS_EMAIL_PILOT_BUSINESS_IDS` expose review setup to selected businesses.
  `*` explicitly exposes every business; an empty list enables none.
- `review_email_control.enabled` and `pilot_business_ids` independently admit
  the same selected businesses in Postgres. Keep the environment and database
  pilot lists aligned. No browser can edit this service-only control row.
- `REVIEWS_EMAIL_SENDING_ENABLED=1` plus
  `review_email_control.sending_enabled=true` permit email submission. Either
  switch can stop new provider calls without disabling webhook processing.
- SMS additionally requires `REVIEWS_SMS_ENABLED=1`,
  `REVIEWS_SMS_PILOT_BUSINESS_IDS`, `REVIEWS_SMS_SENDING_ENABLED=1`, and
  `review_email_control.sms_sending_enabled=true`. Approved registration and
  paid/current `has_review_sms_access` are also required at dispatch. A review
  add-on never grants base-plan AI, inbound lead handling or missed-call SMS.
- Existing SMS plans require administrator evidence for the exact review
  program and a currently approved MARKETING campaign, or approved MIXED
  campaign explicitly containing the MARKETING sub-usecase. CUSTOMER_CARE alone
  is insufficient. New Chat review registrations remain MARKETING campaigns.
  See [Telnyx's mixed-use guidance](https://support.telnyx.com/en/articles/3679260-frequently-asked-questions-about-10dlc).
- New texting registrations can explicitly include reviews during signup.
  Migrations 105–111 provide the mixed-purpose filing, hosted REVIEWS opt-in,
  automatic included-account initialization and exact provider readiness checks.
  These accounts do not require an administrator to repeat the approval step.
  A stored customer keyword event is required for hosted-program review sends;
  an imported phone number or owner checkbox cannot grant that permission.
- Business review pause, operational suspension, payment failure, permission
  revocation and destination suppression are checked again at final admission.

## Email configuration

Use the existing verified Resend sender, `RESEND_API_KEY` and
`RESEND_FROM_EMAIL`. The business's verified Reply-To is distinct from the
provider sender. The confirmed owner email is available immediately; other
Reply-To addresses require one-time confirmation. Test sends only target the
current authenticated owner's confirmed email. Verification and tests each
allow at most five requests per rolling 24 hours and one per minute per business.
They use the same durable queue and provider sending kill switches.

Set `REVIEWS_LINK_SECRET` to an independent random secret of at least 32 bytes.
Changing it invalidates existing public links and previews; retain it across
normal deployments. `NEXT_PUBLIC_APP_URL` is the canonical origin (default
`https://simplassist.com`). Public requests cannot supply redirect destinations.
Local development permits loopback HTTP only outside production. A Google
review destination and verified Reply-To are required for customer email.
Reviews no longer collects or requires a postal address. Generated initial,
reminder and owner-test footers include the business name without a mailing
address. Customer emails retain their review and unsubscribe links. Existing
nullable address data is retained but is not copied into new previews or emails.
Previously rendered outbox messages remain frozen; inspect pending work before
deploying a footer change. All recipients see the same neutral review request;
there is no star-rating gate.

This footer behavior is a product decision, not a determination that the messages
are exempt from applicable email law or Resend's policies. Low volume alone does
not determine that classification. Sending controls and permission requirements
are unchanged.

Register Resend's signed events at `/api/webhooks/reviews-email` and configure
`REVIEWS_RESEND_WEBHOOK_SECRET` from that endpoint's signing secret. Subscribe
to sent, delivered, bounced, complained, failed and suppressed events. The route
checks the untouched request body, timestamp and Svix signatures, stores event
IDs once, and applies terminal states without regressing on reordered events.
The `review_delivery` provider tag correlates callbacks received before the send
response. Webhooks and unsubscribe POSTs remain live while workers are disabled.

## Railway worker

The review worker calls the web application's authenticated internal routes.
Provider credentials, Stripe Price IDs, rollout/provisioning/sending/release
flags and protected Telnyx identifiers belong on the **web service**, where
those routes execute. The scheduler needs the canonical application URL and
matching worker token. Setting provider flags only on the scheduler has no effect.

Deploy the dedicated worker using `railway.review-worker.toml`. It starts
`scripts/review-worker.ts`; no public request or contact-import path sends mail.
Set canonical HTTPS `NEXT_PUBLIC_APP_URL` and identical
`REVIEWS_WORKER_TOKEN` (at least 32 characters) on the web app and worker.

The worker serially polls `POST /api/reviews/internal/run` every five seconds,
then polls `POST /api/reviews/internal/lifecycle` at most once per minute. Both
require the bearer token. The delivery endpoint processes future job-completion
sources, email, then SMS. Lifecycle handles paid registration and resource
release independently of sending switches; its own provisioning/release gates
are default-off. `/health` reports unhealthy when either cycle has not succeeded
for three minutes. Do not expose the worker token to the browser.

## Delivery and recovery

Preview freezes an exact selected audience and expires after 15 minutes.
Confirmation is idempotent and checks current customer addresses, cooldown,
settings revision, ownership, suppression and paid eligibility before creating
outbox records. Provider payloads and identity keys remain fixed across attempts.
Bulk previews read the audience and eligibility in bounded database RPCs.

Each campaign chooses one channel. One optional reminder is scheduled four days
after provider acceptance. Google-link clicks conservatively cancel remaining
requests, without claiming that a review was written. Owner completion marks,
replies to review SMS, opt-out and hard failures also stop reminders. Email
replies go to Reply-To only and cannot automatically stop reminders.

The default send window is 9 AM–6 PM every day in the explicitly recorded recipient
timezone or business timezone. Initial work more than 24 hours past its adjusted
scheduled time becomes `needs_reschedule`; stale reminders expire. Billing or
quota pauses never release a burst of old invitations. Email limits are 500/500/
1000/2000 per existing billing period. SMS invitations, reminders, replies and
inbound parts share the existing SMS pool; the Chat review add-on's allowance is
provided by the separate activation/billing grant.

Carrier-generated STOP, START and HELP confirmations can incur provider charges
outside application reservations. Do not block required opt-out processing or
infer those control messages from arbitrary message text. Reconcile provider
usage and invoices separately; application counters do not claim to include
every carrier-generated control message.

Email ambiguous results retain quota and may retry only the frozen Resend key
within 23 hours from the first submission (Resend's window is 24 hours). Exhausted
or expired retries become `unknown`. SMS ambiguous results are never resubmitted;
the shared reservation ledger and verified receipts can later reconcile them.
Never change a key, erase an uncertain reservation, or manually requeue unknown
mail to force delivery. Investigate the provider record first. Unknown records
continue to prevent duplicate enrollments. Callback reconciliation can recover
accepted sends and create at most one reminder.

Unsubscribe GET displays confirmation; POST performs the opt-out and supports
RFC 8058 one-click requests. A new owner permission attestation cannot clear a
recipient opt-out. STOP is enforced across tenant SMS senders, and START never
re-enrolls a review or releases the human reply hold. The owner must explicitly
resume AI where their base plan already permits AI handling.

Confirmed ready but unpaid SMS accounts expire after seven days. Rejected or
ambiguous setup in `support_required` can retain rented resources and requires
operator reconciliation and cleanup. A purchased phone may not yet be attached
to the review account when setup fails. Inspect the provider and provisioning
ledger before retrying or releasing anything; unsuccessful setup is not
automatically guaranteed to clean up every resource. A fresh Stripe read is
required before preparing cleanup and again before each destructive action.

## Completion automation

Completion automation starts disabled and is selected per business/channel.
Owners separately record customer permission and evidence. Only a new completed
service event with existing unrevoked permission creates a source record. It
schedules next-day 10 AM in the recipient/business timezone. Enabling automation
never scans old jobs, imports or captured leads. The service-event identity is
unique, so reopening and completing again cannot mint another enrollment.
Reopening stops any remaining invitation/reminder. Changing a contact address
or revoking permission blocks dispatch until the owner reviews eligibility.

## Verification

Run `npm test -- src/lib/reviews` and the repository's guarded local database
harness. Database suites 096/099/102 exercise owner/tenant boundaries, verified
email, stable retries and quota, suppression, early/reordered callbacks, stale
sends, SMS no-retry and future-only automation. No live provider credentials or
production send switches are required for those tests.
