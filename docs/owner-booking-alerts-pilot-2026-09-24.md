# Booking alert pilot preparation — September 24, 2026

Bryan requested proceeding with the existing dedicated number and selected the
SimplAssist demo account for the first test. This is authorization to prepare a
limited pilot, not evidence of a new carrier review or successful SMS delivery.

## Verified provider state

- Campaign `CYLIGTZ` (`4b30019d-f3cb-4e4f-b473-9a05bffeccb2`): `ACTIVE`,
  `MNO_PROVISIONED`, no failure reasons.
- Dedicated sender `+15742133931`: `ASSIGNED`; carrier number mappings `ADDED`.
- Profile `40019df3-9a51-4822-ac75-48b62f40a630` contains only that number.
- Profile opt-outs: zero records, zero pages, checked before activation.
- Runtime replies updated and read back: STOP/STOPALL/STOP ALL/UNSUBSCRIBE/
  CANCEL/END/QUIT; START/UNSTOP; HELP/INFO. `ALERTS` is deliberately absent from
  provider auto-response keywords so verification reaches the application.
- The public demo number `+15742638634` and its profile were not changed.
- Dedicated profile inbound webhook changed to
  `https://simplassist.com/api/notifications/sms/webhook` and read back. The live
  endpoint rejects unsigned input with HTTP 401.

## Production configuration

- Existing application release: `c955d4cc80f7771f44fd6007801593754eb2ac3c`.
- Application configuration deployment `5cc75e34-3ef5-437c-98de-034825cebd95`
  passed Railway's healthcheck. Both internal maintenance endpoints returned
  HTTP 200 with `ok: true`; the send endpoint processed zero messages.
- Sender/profile/campaign and pilot business configured on the application.
- Both application enablement flags remain `false` during preparation.
- Database control has matching sender/profile/pilot and remains disabled.
- Pilot business: `ea848911-ef72-44a6-8cf3-c47b3959be26` (SimplAssist).
- New Railway service: `simplassist-booking-alert-worker`,
  `4513d588-1b4c-4f75-a2f0-d256eb9591ba`.
- Worker has only the app origin and a distinct shared internal credential;
  provider/database credentials were not copied to it.
- Railway rejected the TOML config-file assignment for this new service because
  it is deprecated. Equivalent build/start/health settings were applied directly
  and the effective deployment manifest was checked.
- Initial worker deployment exhausted its healthcheck window while the app was
  still building with the new shared credential. After the app succeeded and
  both authenticated endpoints passed, worker deployment
  `c02d82c3-26ee-4279-baa9-e6a51fdba091` passed its healthcheck and became the
  sole active worker deployment with one running instance.

## Test-account prerequisite

The selected demo has an active Full Suite subscription, a connected Google
calendar, and direct scheduling enabled. However, its business goal is `signup`,
so the booking-alert eligibility function correctly returns `false`.

Bryan was asked whether to temporarily switch the public demo to appointment
booking and restore it after the test, or choose another booking business.
No business goal has been changed. No mobile number has been enrolled and no
SMS has been sent by this preparation.

After the test account is ready, enable only its matching application/database
pilot gates, have the owner complete the real consent form and send the exact
one-time verification text from their own mobile, then verify enrollment delivery
and a new confirmed booking alert. Do not claim end-to-end delivery before these
handset and callback checks succeed.

## Follow-up: sign-up alerts scope — September 24, 2026

The earlier prerequisite above describes the booking-only implementation. Bryan
subsequently chose to keep the SimplAssist demo's `signup` goal and defer a live
booking test until a separate booking account is available. The demo's goal is
unchanged; it must not be switched to appointment booking for this pilot.

The local implementation now extends **Business alerts** to a sign-up link text
sent to a caller. Eligible Full Suite sign-up accounts can enroll without a
calendar. The alert uses a successful voice action's recorded provider acceptance
and its validated `goal_events` entry. It reports the link text being sent, not
delivery, a click, or completed registration. Existing booking support remains.

The expanded consent version is `2026-09-24-v2`. Old booking-only enrollments and
pending verification tokens do not silently authorize sign-up alerts; the owner
must complete the expanded consent and fresh mobile verification. Recovery uses
the original immutable caller-SMS acceptance time and never resends that caller
SMS. Sign-up sends before owner verification, historical restoration events, and
sends older than 24 hours do not generate owner alerts.

Sending remains off pending the release and configuration checks. This follow-up
records the implementation scope, not a production deployment, new campaign
approval, successful owner enrollment, or end-to-end SMS result. Next steps are
to apply and verify the expansion, align Telnyx's description/flow/samples and
runtime replies with both alert types, then enable only the existing demo pilot
when those checks are complete. Bryan will enter his own mobile, explicitly
consent, and send the displayed verification text before testing a new real call
that requests the sign-up link. Record handset delivery and callback results
separately when observed.

### Release validation

- Root application suite: 444 files / 7,480 tests passed (unrelated `.worktrees`
  copies excluded); production build passed.
- Database: all 86 pgTAP files / 3,682 assertions passed after replaying migrations
  through 094 in the dedicated disposable `SimplAssistSignup094` local stack.
  Temporary test copies adapted older dblink hostnames and local-only attestation
  to that isolated stack; the repository's guarded harness was not weakened.
- Independent review corrected an acceptance-path lock dependency by queueing from
  recoverable goal-event bookkeeping, and corrected legacy pending-v1 enrollment
  display so sign-up owners can explicitly verify the expanded consent.
- Real handset verification, enrollment delivery, and a caller-link alert remain
  to be exercised after deployment and the limited pilot is enabled.
