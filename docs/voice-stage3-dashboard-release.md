# Voice Stage 3 — dashboard integration

## Scope

This batch connects the accepted private voice signup experience to Leads and owner call review. Voice style, confirmation logic, pilot admission/budget, booking enablement, subscription features and provider voice configuration are unchanged. Top-tier entitlements, monthly minutes, commercial pricing, broader booking verification and public homepage/checkout changes remain later batches.

Starting point: `e2047f53b802d6a796217b5c08ac65c391d358b0`, isolated branch `codex/voice-stage3-dashboard`. Preserve the original voice-pilot worktree and unrelated root work.

## Reviewable phases

1. **Database provenance:** migration 080 links a genuine voice confirmation and action to the original outbound SMS and immutable signup lead. Provider identity, acceptance time, lead bookkeeping and delivery are separate. The service-only finalizer writes local records atomically, reuses an existing message before selecting a thread, and never recreates deleted provenance.
2. **Reliable bookkeeping:** accepted sends save provider identity/time before optional bookkeeping. A bounded, independent maintenance sweep repairs missing Leads or usage bookkeeping without sending a message. Existing SMS usage keys remain unchanged. The fixed historical restore defaults to dry-run and permits only the three reviewed delivered signup actions.
3. **Owner review:** business-scoped call details, confirmed-versus-stored contact data, factual action outcomes, protected audio playback and linked call/text/Leads/contact navigation. Existing transcript rendering remains read-only. No provider credentials, download URLs or raw action evidence are returned to the UI.
4. **Verification and deployment:** test the migration and application, walk the local dashboard, apply and independently verify production schema, deploy a private source archive to the application only, restore verified historical rows, and independently verify the result. Final acceptance includes a new caller-driven test.

## Historical restoration

Run `node scripts/restore-voice-signup-leads.mjs` with the correct project's server credentials held in the process environment. It does not load environment files or fetch credentials. `--dry-run` is the default; `--apply` performs the reviewed repair after repeating guards. The checked-in manifest pins the business and three call/action pairs. No provider client, send operation, action replay or usage writer is used.

The original outbound message timestamp is the documented fallback for these historical rows when provider acceptance time was not stored. This creates `time_source=message_recorded`; it does not pretend a provider acceptance timestamp was measured. New sends use their stored acceptance time. Repeating the repair must insert zero additional events.

## Verification record

Pre-deployment checks passed:

- Full unit/integration suite: **393 files / 6,651 tests**. Subsequent build-only prop/type corrections passed their 29 targeted tests; responsive changes passed 19 focused tests.
- Isolated local database suite: **69 files / 3,014 assertions**, including overlapping finalizers and deletion replay. Local harness regression checks: 13 tests.
- Application production build (including lint/generated route type checks) and worker TypeScript passed.
- Two-round independent SQL/recovery review and independent owner API/UI review passed after corrections.
- Local browser walkthrough with synthetic data verified Leads, correct call/contact deep links, confirmed versus stored identity, truthful delivery outcomes, expired-audio display, safe authenticated API projection and read-only controls. Desktop and 390px mobile layouts were inspected; measured mobile content width equaled viewport content width after the responsive fix. Browser reported no page errors.
- Actual retained production audio playback and a new caller-driven signup call remain customer acceptance checks. No automated customer text or external model evaluation was run.

Canonical migration 080 MD5: `b889ea920d5854f34824f4908a107792`. Independent production baseline found three delivered signup actions, three original SMS records, three matching usage entries, zero Leads events, and the existing pilot settings unchanged.

Production migration 080 was applied in one transaction and independently verified on 2026-09-17 at 04:48 UTC. The stored migration checksum and all eight deployed function hashes matched the tested local schema. Expected columns, indexes, triggers, service-only execution grants and owner-read policies were verified. The three original messages, three usage entries, original timestamps and pilot settings remained unchanged, with zero Leads before restoration.

Never treat a normal hangup or delivered link as proof that a caller signed up, booked, or approved the dashboard.

### Production release

- Application deployment `2171f020-ba83-4817-a67a-c6bc06195493` succeeded from private source revision `46854d9`. The archive SHA-256 was `ca5fdbc6fdf662fbb080e0fdf90932e4b7c147c44369193566ea54a52763b980`; it contained no environment files or local dependencies. Later edits to this release record do not change deployed code.
- Application health, worker health and authenticated worker readiness returned HTTP 200. The worker reported ready with no active calls and the existing action protocol. Unauthenticated private readiness returned 404; unauthenticated owner call review returned 401. Internal application/worker credentials matched without being printed.
- Guarded restoration inserted exactly **three** historical Leads. Repeating the apply returned **zero inserted / three already present**, with no rejected records. Both runs made **zero provider calls and zero usage writes**.
- All restored events retained their original outbound-message timestamps and `time_source=message_recorded`. No historical provider acceptance time was invented.
- Independent read-only verification at 04:54 UTC confirmed one event per approved action, matching business/contact/call/confirmation/text links, original dates, exactly three matching provider submissions and usage records, and unchanged pilot settings. Voice worker deployment `5624ebab-c00e-41d3-88d0-328324c7a993` and scan worker deployment `12c2582a-2263-4055-92a8-1f4eaf27c642` remain unchanged.
- Caller-driven test `4297c1aa-2739-4d36-9b52-8d4edd4ffe6b` ended normally at 04:58 UTC (`caller_hangup`, no backend error or fallback recorded). Its recording is retained through 2026-10-17. It contained an unconfirmed contact action but no signup action, send, usage charge or new Leads event, so it did **not** exercise new-send dashboard bookkeeping. A completed signup-send test and retained recording playback through the owner's dashboard remain pending acceptance; the three restored historical Leads remain independently verified.
- The unconfirmed contact action's later `superseded` status is expected on call closure and alone does not establish a correction, decline or failure. Automatic approval review blocked the scoped production transcript read pending explicit user authorization; no transcript diagnosis or spoken-behavior change was made. The new provider-acceptance/finalization path was not reached by this call.
- The user subsequently authorized transcript inspection and reported repeated assent. Investigation confirmed a missing playback-acknowledgment loop before action execution. The separately tested worker correction is documented in [Voice confirmation playback fix](voice-confirmation-silence-fix.md); dashboard acceptance still requires a successful new signup send.

## Deployment and rollback

Use the existing private Railway archive upload workflow, not a public GitHub push. Additive schema first, independently verify, then deploy application and restore history. The voice and scan workers require no change for this batch. Preserve private tester access and the existing 200-minute lifetime pilot budget; booking stays disabled.

Rollback the application to its prior successful deployment, retaining migration 080 and valid history. Do not delete events, resend SMS, or replay voice actions. Existing action/provider records remain authoritative for recovery.

## Customer walkthrough

1. Open **Leads**: check the three historical signup texts, original dates, delivery labels and confirmed contact details.
2. Use **View call**, **View text conversation** and **View contact** to verify the linked records.
3. In an **AI voice call**, review the outcome, contact differences, transcript and retained recording. The call has no send/takeover controls.
4. Make one new approved-tester call and accept the signup link. Check exactly one received text and one corresponding new Leads entry. Confirm the voice experience remains as approved.

## Later Stage 3 batches

- Server-enforced Pro / Full Suite voice access; the $45 tier keeps its current features. Text follow-up or voice answering as the primary unanswered-call response, with optional eligible text fallback.
- Monthly voice allowance, usage display, warnings, reservation and subscription lifecycle rules. Choose price/allowance using measured costs. Paid extra usage needs separately verified pricing, explicit opt-in and billing.
- Controlled multi-business rollout and isolation tests; approved calendar/voice booking and invitation verification; public greeting/recording experience; outstanding structured call/failure acceptance.
- Limited customer cohort, then coordinated top-tier checkout, billing, onboarding, settings and homepage feature list before broad release.
