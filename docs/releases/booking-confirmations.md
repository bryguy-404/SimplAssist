# Booking confirmations release

## Scope and commits
Baseline: `59484b1`; feature branch: `codex/booking-confirmations`.
- `73e805a`: business/service booking settings and storage.
- `6c0b856`: revisioned booking authorization shared by voice, SMS and web chat.
- `49f08f6`: permission-bound voice texts and dashboard review.
- `b02e272`: validation evidence and recovery/signup compatibility hardening.

The runtime feature flag is `BOOKING_CONFIRMATION_V2_ENABLED=true`. The database also requires `booking_confirmation_control.enabled=true`. Both default off. The updated voice worker advertises `bookingProtocol: 1`; an enabled application refuses an incompatible worker. Deploy the worker before activating the application feature.

## Verified behavior
- Business default format/label/duration/address, service overrides and unavailable-for-direct-booking choices are protected by fresh owner access and settings revisions.
- Legacy unconfigured businesses retain neutral 30-minute appointments; no business is silently converted to callbacks or site visits.
- Direct scheduling reviews the current immutable details, checks the full service duration and uses the existing calendar reservation/idempotency/reconciliation path. Corrections require a new review and assent. Optional email is not a requirement.
- Collect-info mode saves a request; it never claims that a calendar appointment exists.
- Voice offers a final text after success; a review text is optional. Each text requires separate spoken permission for the calling number. Permission to text cannot book. Spoken corrections remain in the call; an SMS reply to a live review redirects the caller to that call.
- Provider acceptance is stored separately from delivery, the outbound message and usage. Known acceptance can recover without another send. Unknown provider results are not automatically resent.
- SMS and website chat review/confirm in their existing conversation. Web-chat replies do not trigger SMS. The SMS review uses a durable send claim; web-chat summary acknowledgment can recover from its committed message.
- Appointment snapshots and notification outcomes appear in Conversations; existing booking-request links open that conversation. Calendar event details display a location when supplied.
- Signup Leads semantics, voice tone/audio/confirmation boundaries, billing and pilot retirement are preserved. No automatic reminders, outbound callbacks, rescheduling, cancellation or public booking links were added.

## Validation
- Full regression checkpoint: 415 files / 7,023 tests passed, including the local WebSocket capacity test (run separately after its initial sandbox listen restriction).
- Additional focused release checks: 162 passed, then 38 route/routing checks passed.
- Isolated database checkpoint through migration 090: 79 files / 3,418 assertions passed. Final release rerun includes the signup identity regression.
- Application and worker TypeScript, ESLint, and optimized Next.js build passed at the phase-3 checkpoint. Final release checks are recorded below.
- Browser checks used a synthetic local account at port 55321 and app port 3105. Business-visit address/name/60-minute duration saved and survived reload. The review panel showed the historical customer-site request distinctly from current settings and saved contact details. Desktop and 390px mobile screenshots showed no horizontal overflow or framework/browser errors.
- All automated provider action tests are mocked. No real texts, calendar invitations, purchases, production database changes or deployments were performed during development.

## Production sequence
1. Confirm target project `inmgpkurctttsofpywuz`, schema baseline 087, and current app/worker deployment IDs.
2. Apply migrations 088, 089, 090 in order using the established production migration workflow; record migration versions and verify table constraints, owner policies, backend-only RPC grants and false rollout control.
3. Deploy committed source privately to Railway voice service `aec0a33c-df1a-4924-bf79-8678cb4f4eea`, preserving its existing start command and environment. Verify readiness includes booking protocol 1.
4. Deploy the same source to application service `a0147f69-17f1-484a-a02d-e60e73b7c1d4` with the new flag off. Verify health and unauthorized history/settings access. Do not deploy the scanner service or push the public GitHub remote.
5. Enable the database control and app/worker feature flag only after schema and compatible deployments are verified. Recheck readiness and ordinary signup routing. No subscription, account goal, pilot tester or phone-number change is needed.
6. Verify the production outcome under the project's independent-read-only verification requirement. Do not represent self-generated reports as independent verification.

## Real booking acceptance
Use an approved real booking business with its connected calendar; do not create another Telnyx account or change Bryan's signup account. Test callback, business visit and customer-site configurations; known/unavailable slots; declined email; corrected name/email/date/address; interrupted readback; review-text correction and final fresh confirmation; declined text; hangup after permission; duplicate delivery/webhook retries; and uncertain provider results.

For each successful direct booking: exactly one event in the correct calendar, correct duration/location/contact details, and invitation requested when email was supplied. Check actual invitation receipt separately. For collect-info: one owner-review request and no event. For accepted final SMS: one message, one usage identity, correct details and observable delivery status. No signup Lead should be created by a booking text.

Real booking/calendar-invitation acceptance remains outstanding until that approved account is available.

## Rollback
Disable the app feature flag and database control, coordinate app/worker rollback, and preserve all existing records. Do not replay uncertain sends/bookings. Do not disable the flag mid-submission without first draining active booking actions; in-flight accepted effects still need reconciliation. Keep the private pilot retired.

## Current release state
Bryan explicitly authorized applying migrations 088–090, deploying both services and a separate read-only production review. The atomic bundle was applied to project `inmgpkurctttsofpywuz`; independent verification confirmed migration history 090, RLS, backend-only mutation permissions and preserved signup/account/pilot state. The stored booking-enabled setting is true, but signup goal prevents booking offers/actions; it was not modified.

Private source archive `b02e272e1960f104c3cf6e46e3d6bc2c65eced6a`, SHA-256 `f6d0c51cd72a9c2c06b44df2bc2f581ee7de4ceccd6cae7a5a7e270eb4eb8559`. Independent review byte-matched all 1,234 application files and 1,232 worker files. Only the worker archive excludes the two Railway application/scanner config files, preserving its existing service configuration. No public Git push.

Both initial disabled-feature deployments passed health checks. Database control and runtime flags were then enabled. Final activation verification follows below.

## Final local verification
- Full regression: **417 files / 7,034 tests passed**, including the socket capacity test. Three additional notification-recovery tests passed after the final audit.
- Database replay: **79 files / 3,419 assertions passed** through migration 090.
- App and worker TypeScript, ESLint and production build passed.
- Recovery retains an independent action-bookkeeping marker, so a delivered text cannot fall out of recovery before its action outcome is saved. Existing contact/signup fingerprints remain unique even when superseded.
- Reviewable SQL-editor bundle: `/tmp/simplassist-booking-migrations-088-090.sql`, SHA-256 `c53770aa8b1230874245223baec1799e950103968d981316c682586deb171d48`. It verifies baseline 087, applies the three migrations in one transaction, records their history and leaves the new database feature control off. Regenerate with `scripts/build-booking-migration-bundle.mjs`; the script never connects to a database.
- Production release explicitly authorized and executed under the recorded migration/independent-verification workflow.

## Final production verification — September 17, 2026
Independent read-only reviewer: `booking_release_verification`; result **PASS**, no release blocker found.
- Application `2d9d2046-1c7c-4645-93f8-2a3a7adcc801`: **SUCCESS**.
- Voice worker `1d28d7ac-29e0-42ec-a8f5-d85ecd667e8b`: **SUCCESS**.
- Scanner unchanged at `12c2582a-2263-4055-92a8-1f4eaf27c642`.
- Both runtime flags and database control enabled. App health and authenticated worker readiness HTTP 200; booking protocol 1, action protocol 1, existing gpt-live-1/PCM16 configuration preserved.
- Anonymous booking settings and conversation booking-history requests return 401.
- Six new tables have RLS; inspected mutation RPCs are postgres/service_role-only; owner policies and current-draft/fingerprint uniqueness indexes verified.
- Own account remains active Full Suite, signup goal, owned, unsuspended and undeleted. Pilot remains disabled/retired with zero testers. No subscription or billing change was performed.
- No booking drafts or notification rows were created by release verification. Real booking/calendar invitation/text receipt acceptance remains outstanding on the approved booking business.

The reviewer performed no mutations. Initial disabled-feature deployment IDs were app `5f95adc7-dbbc-47e9-9df6-f01a39e8e511` and worker `1a68c828-6ac9-4d38-b8fe-b65cc414ce8e`; activation deployments above use the same reviewed source. This release-record update changes documentation only.
