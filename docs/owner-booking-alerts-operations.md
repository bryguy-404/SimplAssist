# Owner booking SMS alerts

This program sends SimplAssist account notifications to a verified business owner.
It is separate from customer AI messaging, tenant phone provisioning, customer SMS
credits, and call forwarding. The first release supports US mobile recipients and
new appointments confirmed by SimplAssist in Google Calendar, including eligible
Chat Only and partner-managed accounts. No historical bookings are backfilled.

## Application and database release

1. Apply migration `093_owner_booking_alerts.sql` before deploying this application.
   Its singleton control row defaults to **disabled**. It adds a transactional
   outbox trigger to the first pending-to-confirmed calendar booking transition;
   it does not perform network requests inside a booking transaction.
2. Deploy with both `OWNER_BOOKING_ALERTS_ENABLED=false` and
   `OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED=false`. The real form is available at
   `/settings#booking-alerts` but clearly disables activation. `/booking-alerts`
   explains the program publicly; privacy and terms have separate owner-alert
   sections. Existing tenant/demo messaging stays on its current endpoints.
3. Deploy one independent Railway worker with `railway.booking-alert-worker.toml`.
   It posts to `/api/internal/booking-alerts/run` serially every five seconds.
   Once per minute it also posts to `/api/internal/booking-alerts/reconcile` with
   a separate request timeout, so Google recovery cannot exhaust the SMS
   dispatch request's time budget. The two requests run serially.
   It does not depend on the voice tier/worker and does not replace or duplicate
   the account-cleanup cron. `/health` becomes unhealthy after three minutes
   without a successful maintenance request. The request credential must match
   the application. The worker needs no provider/database keys.

Server-only configuration (no `NEXT_PUBLIC_` copies):

| Variable | Purpose |
| --- | --- |
| `OWNER_BOOKING_ALERTS_ENABLED` | Exact `true` permits the application sending path; default off. |
| `OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED` | Exact `true` only after the revised program is accepted. |
| `OWNER_BOOKING_ALERTS_SENDER_E164` | Exact dedicated platform number; candidate `+15742133931`. |
| `OWNER_BOOKING_ALERTS_MESSAGING_PROFILE_ID` | The dedicated, verified platform messaging profile. |
| `OWNER_BOOKING_ALERTS_CAMPAIGN_ID` | Accepted platform campaign reference. |
| `OWNER_BOOKING_ALERTS_PILOT_BUSINESS_IDS` | Optional strict comma-separated business UUIDs; malformed lists fail closed. |
| `OWNER_BOOKING_ALERTS_INTERNAL_TOKEN` | Distinct random secret, at least 32 characters, shared with the worker. |
| `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY` | Existing provider API credentials and webhook verification key. |

The worker also needs `NEXT_PUBLIC_APP_URL=https://simplassist.com`. This is the
only public-named variable it uses; its internal bearer token is never public.

The database control row independently gates enrollment, enqueue, and final
submission. Configure its exact sender/profile and pilot business UUIDs to match
the application. Both gates must agree. Do not set the database gate as part of
the migration or commit real credentials. Setting either gate off stops future
submissions; it cannot recall an SMS already accepted by the provider.

## Telnyx review and activation

The historical unsaved editor values are in
`owner-booking-sms-telnyx-handoff-2026-09-23.md`. They are a record, not a ready-to-submit
description of the final implementation. Update them to match this actual flow:

1. An authenticated owner opens Settings → Booking alerts, enters their own mobile,
   and explicitly checks the optional consent checkbox. No onboarding/forwarding
   number is silently enrolled. The system verifies US/mobile metadata and
   rejects SimplAssist-managed assistant numbers.
2. The owner sends the exact prefilled `ALERTS <one-time token>` to the platform
   number from the entered mobile. The challenge expires after 15 minutes.
   We verify the signed incoming message, number, owner, business, and challenge.
3. Only that business's enrollment is enabled; one confirmation text is queued.
   Confirmed new bookings then produce a business name, appointment date/time
   with timezone, and a link. Customer names and appointment details remain in
   the authenticated dashboard.
4. STOP pauses alerts to that mobile across all businesses in this program.
   START clears the shared block but does not enroll any business; the owner
   explicitly verifies again in Settings. Turning alerts off in Settings affects
   only that business. Changing a phone preserves the old enrollment until the
   replacement is verified, then invalidates older pending alerts.

Use the actual form/evidence and versioned disclosure in `contracts.ts`, with
`https://simplassist.com/privacy#owner-booking-alerts` and
`https://simplassist.com/terms#owner-booking-alerts`. Reviewers may need screenshots
or a demonstration of the authenticated form; the public description alone is
not proof of a completed opt-in. Do not claim approval for an unimplemented flow.

Try the current Account Notification campaign **CYLIGTZ** first. Confirm the revised
description, message flow, samples, embedded-link attribute, and policies actually
persist and any required review completes. Its old Active status is not proof of
acceptance of the revised program. If these changes cannot be accepted, use a
replacement campaign under the existing verified SimplAssist brand and move
the unused number only after approval. Do not change demo number `+15742638634`.

The actual booking link format is:
`https://simplassist.com/booking-alerts/open/<opaque-token>`.
Links are navigation references, not login links. They expire after 90 days,
require current ownership/recipient binding, and resolve the currently verified
partner domain where applicable. The destination dashboard always requires login.
GET/HEAD previews do not consume links. No request-controlled redirect target is used.

Configure the **messaging profile inbound webhook** to
`https://simplassist.com/api/notifications/sms/webhook`. Outbound sends specify that
same endpoint with a unique `?attempt=<uuid>`. Campaign provisioning webhooks are
a different setting. Confirm delivery payloads include the signed `webhook_url`
with that reference; callbacks without it cannot reconcile an ambiguous send.

Configure the dedicated profile's runtime STOP/START/HELP auto-responses to match
the program; campaign keyword descriptions alone do not configure runtime replies.
The application does not duplicate those provider replies. HELP must identify
SimplAssist booking alerts and give `bryan@simplassist.com`.

Before enabling either gate, reconcile existing opt-outs from the dedicated
profile into `owner_booking_alert_recipients` (use the service-only suppression
RPC and preserve provider event order). A previously unused number still needs
this check. Existing suppression is never erased by a Settings edit; a provider
opt-out rejection also repairs missing local suppression.

Activate initially for the same single pilot business in both gates. Verify:

- Explicit consent and inbound verification; wrong-number/expired texts fail.
- A real Chat Only booking produces exactly one owner alert; no tenant SMS usage.
- Enrollment and booking callbacks reach `accepted` then `delivered` (distinct states).
- STOP blocks queued and future alerts; START plus fresh verification restores
  only the explicitly enrolled business. Test shared mobile/multiple businesses.
- Phone replacement, partner dashboard login, and account disable/deletion.
- The worker health endpoint and delivery backlog recover after a restart.

Then remove the pilot restrictions deliberately. No live verification/send test
is part of local automated testing. Provider fees remain platform expenses.

## Reliability, privacy, and troubleshooting

Claims and final submission are token-fenced. The provider client disables
automatic retries. A known rate-limit rejection can retry with bounded backoff;
timeout/connection failure after submission becomes `uncertain` and is never
blindly resent. Signed callbacks can recover an accepted response lost locally.
Duplicate or reordered callbacks cannot downgrade final delivery state. This
prevents duplicate application sends; handset delivery is not an exactly-once
guarantee. New booking alerts expire before their appointment or after 24 hours.

The worker limits processing and the database serializes the shared sender to
at most one submission per second. No profile pooling or fallback to customer
numbers is used. Queue/callback failures do not ask the assistant to book again.

Operational tables are service-only. `owner_booking_alert_settings` alone permits
owner-scoped SELECT; mutations use authenticated API plus owner-bound RPCs.
Challenge tokens are stored as digests. Stored webhooks contain only validated
processing facts, not arbitrary replies or raw verification text. Provider message
IDs, segment counts, and reported costs are recorded separately from tenant meters.

Processed webhook records expire after 30 days; expired challenges and lookup
attempts after one day; terminal delivery content/navigation data after 90 days.
Consent evidence remains separate, and the minimal STOP suppression record is
retained to prevent accidental re-enrollment. Ownership removal and permanent
account cleanup scrub business-associated alert records; soft deletion disables
the enrollment and cancels unsent alerts.

Monitor counts by outbox status and oldest pending age, recent sanitized error
codes, worker health, and unprocessed webhook count. Never log full mobile numbers,
verification tokens, SMS content, or navigation tokens. Investigate `uncertain`
records by their provider callback/reference; do not reset them to pending.

Rollback: switch the application and database gates off. Do not roll back booked
appointments or delete the consent/suppression evidence. Keep the signed webhook
endpoint available to receive STOP and final delivery receipts.
