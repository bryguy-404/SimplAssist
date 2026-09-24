# Owner business SMS alerts

This program sends SimplAssist account notifications to a verified business owner.
It is separate from customer AI messaging, tenant phone provisioning, customer SMS
credits, and call forwarding. The visible feature is **Business alerts**; existing
`owner_booking_alert_*` storage, configuration names, and `/booking-alerts` URLs
remain compatible. It supports US mobile recipients and two account-goal events:

- **Book appointments:** a new appointment confirmed by SimplAssist in Google
  Calendar, including eligible Chat Only and partner-managed accounts. Direct
  scheduling and a connected calendar are required.
- **Sign-ups:** a sign-up link text accepted by the provider for a caller from
  a real voice call. The account needs an effective Full Suite/voice entitlement,
  the `signup` goal, and a valid HTTPS sign-up link. It does not need a calendar.
  An alert reports a link text sent, not delivery, a link click, or registration.

Both paths require an active eligible account, explicit owner consent, and mobile
verification. Chat/widget links and other sign-up channels do not trigger this
release. No historical bookings or legacy sign-up texts are backfilled.

## Application and database release

1. Apply migration `093_owner_booking_alerts.sql`, then
   `094_owner_signup_link_alerts.sql`, before deploying the expanded application.
   The original singleton control row defaults to **disabled**; the expansion
   preserves the existing OFF/pilot controls. The first migration adds a
   transactional outbox trigger to the first pending-to-confirmed calendar booking
   transition. The expansion adds a trigger for a validated voice sign-up
   `goal_events` record and one owner alert per voice action. Neither trigger makes
   network requests. Existing booking support stays available under its own
   per-kind eligibility checks.
2. Deploy with both `OWNER_BOOKING_ALERTS_ENABLED=false` and
   `OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED=false`. The real form is available at
   `/settings#booking-alerts` but clearly disables activation. `/booking-alerts`
   explains the program publicly; privacy and terms have separate owner-alert
   sections. Existing tenant/demo messaging stays on its current endpoints.
3. Deploy one independent Railway worker with `railway.booking-alert-worker.toml`.
   For a newly created Railway service, apply the same build/start/health/restart
   values directly to its service settings. Railway rejected assigning a TOML
   config file to the new production worker on September 24, 2026 because Config
   as Code is deprecated for new services. Do not let it inherit the web app's
   `npm start` command or `/api/health` healthcheck. The production worker uses
   `npm run start:booking-alert-worker`, `/health`, one replica, and no sleeping.
   It posts to `/api/internal/booking-alerts/run` serially every five seconds.
   Once per minute it also posts to `/api/internal/booking-alerts/reconcile` with
   a separate request timeout, so Google recovery cannot exhaust the SMS
   dispatch request's time budget. The two requests run serially.
   The alert dispatcher does not replace the voice worker or account-cleanup cron.
   Booking alerts do not depend on the voice tier. Sign-up alerts use the existing
   voice action/bookkeeping path described below. `/health` becomes unhealthy after
   three minutes
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

1. An authenticated owner opens Settings → Business alerts, enters their own mobile,
   and explicitly checks the optional consent checkbox. No onboarding/forwarding
   number is silently enrolled. The system verifies US/mobile metadata and
   rejects SimplAssist-managed assistant numbers.
2. The owner sends the exact prefilled `ALERTS <one-time token>` to the platform
   number from the entered mobile. The challenge expires after 15 minutes.
   We verify the signed incoming message, number, owner, business, and challenge.
3. Only that business's enrollment is enabled; one confirmation text is queued.
   Confirmed new bookings then produce a business name, appointment date/time
   with timezone, and a link. Sign-up-link alerts name the business, state that a
   sign-up link was sent to a caller, and provide a dashboard link. Customer
   names, phone numbers, and other customer details remain in the authenticated
   dashboard; they are not included in either owner-alert text.
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

The expanded program uses consent version **`2026-09-24-v2`**, which explicitly
covers confirmed bookings and sign-up links sent to callers. Existing
`2026-09-23-v1` booking-only consent remains valid for booking alerts; it does not
silently expand to sign-up alerts if a business changes its goal. A sign-up account
with an old enrollment or pending v1 token must review the v2 disclosure and send
a new verification text. The application and database enforce this restriction
at enrollment, verification, enqueue, and final submission. Preserve the original
consent evidence rather than rewriting its version.

Try the current Account Notification campaign **CYLIGTZ** first. Confirm the revised
description, message flow, samples, embedded-link attribute, and policies actually
persist and any required review completes. Its old Active status is not proof of
acceptance of the revised program. If these changes cannot be accepted, use a
replacement campaign under the existing verified SimplAssist brand and move
the unused number only after approval. Do not change demo number `+15742638634`.

The link format for both alert types is:
`https://simplassist.com/booking-alerts/open/<opaque-token>`.
Links are navigation references, not login links. They expire after 90 days,
require current ownership/recipient binding, and resolve the currently verified
partner domain where applicable. The destination dashboard always requires login.
GET/HEAD previews do not consume links. Both kinds resolve to the account dashboard;
they do not bypass login or promise a direct link to an individual call or booking.
No request-controlled redirect target is used.

Configure the **messaging profile inbound webhook** to
`https://simplassist.com/api/notifications/sms/webhook`. Outbound sends specify that
same endpoint with a unique `?attempt=<uuid>`. Campaign provisioning webhooks are
a different setting. Confirm delivery payloads include the signed `webhook_url`
with that reference; callbacks without it cannot reconcile an ambiguous send.

Configure the dedicated profile's runtime STOP/START/HELP auto-responses to match
the program; campaign keyword descriptions alone do not configure runtime replies.
The application does not duplicate those provider replies. HELP must identify
SimplAssist business alerts and give `bryan@simplassist.com`. Keep `ALERTS` out of
provider auto-response keywords so the exact verification text reaches the
application. Campaign samples and runtime replies must cover the expanded program;
the earlier booking-only save does not establish approval for this expansion.

Before enabling either gate, reconcile existing opt-outs from the dedicated
profile into `owner_booking_alert_recipients` (use the service-only suppression
RPC and preserve provider event order). A previously unused number still needs
this check. Existing suppression is never erased by a Settings edit; a provider
opt-out rejection also repairs missing local suppression.

Activate initially for the same single pilot business in both gates. Verify:

- Explicit consent and inbound verification; wrong-number/expired texts fail.
- A real sign-up call on an eligible Full Suite account produces one owner alert
  only after its caller SMS is accepted. No calendar or goal change is needed.
  The caller SMS continues using its existing customer messaging allowance; the
  separate owner alert does not consume tenant SMS credits.
- A real Chat Only booking produces exactly one owner alert; no tenant SMS usage.
  Defer this live check if no booking account is available rather than changing a
  sign-up demo's goal without authorization.
- Enrollment and each tested alert's callbacks reach `accepted` then `delivered`
  (distinct states). A sign-up-link alert never establishes caller registration.
- Old booking-only consent and old pending tokens do not enable sign-up alerts.
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

Sign-up source evidence is the immutable provider identity and acceptance time
stored on the successful `voice_actions` row, followed by its validated
`goal_events` entry (`origin_kind=voice_action`, `goal_at_event=signup`,
`event_type=link_sent`, `channel=sms`, `time_source=provider_accepted`). The event's
time must match the action's original `sms_accepted_at`. Synthetic demo sessions,
cross-business or cross-conversation references, uncertain/failed caller sends,
and known delivery failures cannot authorize a new owner alert.

The existing `recoverVoiceSignupBookkeeping` flow retries the database bookkeeping
after a caller SMS has already been accepted; it does **not** resend that SMS.
If a temporary bookkeeping failure prevented the goal event and owner outbox row
from committing, recovery can create them with the original acceptance timestamp.
The unique voice-action constraint prevents duplicate owner alerts. No deployment
backfill is run: the send must occur on or after the owner's verified enrollment
and within the last 24 hours, and its owner alert expires exactly 24 hours after
acceptance. Historical `message_recorded` restoration events and sends predating
verification cannot generate alerts. Replaying bookkeeping does not refresh this
window. Eligibility, v2 consent, suppression, and both gates are checked again
before submission.

The worker limits processing and the database serializes the shared sender to
at most one submission per second. No profile pooling or fallback to customer
numbers is used. Queue/callback failures do not ask the assistant to book again or
resend a caller's sign-up link.

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
appointments, resend accepted caller texts, or delete the consent/suppression
evidence. Keep the signed webhook endpoint available to receive STOP and final
delivery receipts.
