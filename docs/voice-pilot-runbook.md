# SimplAssist voice pilot: deployment and testing

## Scope and current status

Stage 1 is an internal **business Q&A pilot** on **(574) 263-8634**, for business `ea848911-ef72-44a6-8cf3-c47b3959be26`. Only approved testers enter voice. The $45 subscription and public callers' existing experience stay in place. No contact-saving, sending links, or calendar actions are available to the voice model.

Implementation is on `codex/voice-pilot`, based on `origin/main` at `4853daf`. The first four implementation phases are committed independently:

| Phase | Commit | Result |
| --- | --- | --- |
| 1 | `701b055` | Shared approved facts, voice channel, isolated pilot admission and storage |
| 2 | `6fff819` | Persistent Telnyx/GPT-Live audio bridge and call-scoped delegation |
| 3 | `80160b2` | Existing-number routing, ringing, recording notice and one-response handling |
| 4 | `f915046` | Admin review, recordings, retention, cost controls and recovery |
| 5 | `eea428c` | Readiness script, saved worker settings and acceptance runbook; activation pending |

**A passing local harness does not make the pilot callable.** Production migrations are applied and verified. The application and voice worker are deployed, the dedicated OpenAI key passes model access, and one approved tester is saved. The private pilot is enabled for the approved tester. The first inbound tester call completed and Bryan gave positive naturalness feedback. The remaining structured calls and full accuracy/audio-quality acceptance are outstanding; infrastructure readiness alone is not evidence that a caller has heard a correct answer. Record actual deployment and acceptance results below; do not infer them from simulated audio or model availability.

## Verified implementation checks

- Application tests: **378 files / 6,394 tests passed**.
- Database tests: **60 files / 2,740 checks passed**, including concurrent admission and post-test cleanliness.
- TypeScript, ESLint, production build and the dedicated worker TypeScript build passed. Build used disposable local credentials and a dummy email key; it did not exercise paid providers.
- Browser verification: protected admin login, tester settings saved and audited in the database, feedback saved, read-only call transcript/usage review, desktop and 390-pixel phone layouts, no page overflow or browser errors. Unauthenticated settings mutation returned 404.
- Both PCM16/16 kHz and PCMU/8 kHz bridge profiles passed the injected-socket audio harness. Tests include a two-second provider startup, corrections, duplicate and reordered events, missing final usage, operational stops, and failures.
- Bryan approved the naturalness of the first live call. Its metadata confirms a normal caller hangup, 75 seconds of confirmed voice usage, acknowledged playback, and one recording. The full acceptance set, measured playback latency, and recording-content review remain outstanding.

The database suite ran in a separately initialized disposable `SimplAssistVoice` Supabase stack at local ports 55321/55322. This preserved the original checkout's local database. A temporary copy of the guarded database harness used that project name and ports; copied concurrency-test dblink hosts were changed to `supabase_db_SimplAssistVoice`. No production DB URL was passed to that harness. For routine verification on the repository's own disposable stack, use `npm run test:db:local` and retain its local-only guards.

## 1. Database deployment — applied and verified September 15

The usual [production migration workflow](PROJECT_LOG.md#2-working-agreements) remains in place. For this update, Bryan explicitly approved the agent applying the prepared migrations and verifying them afterward ("Yes please" in response to the request to apply these migrations to the live SimplAssist database). This is a one-time exception, not a change to the general production rule.

These files were applied **in order**, with each file in its own transaction:

1. `supabase/migrations/069_voice_pilot_foundation.sql`
2. `supabase/migrations/070_voice_session_lifecycle.sql`
3. `supabase/migrations/071_voice_recordings.sql`
4. `supabase/migrations/072_voice_pilot_operations.sql`

The foundation inserts only the designated account's **disabled** pilot settings when that account exists. Default budget is 12,000 seconds (200 minutes), max two calls, max 600 seconds per call. There are no tester numbers in the migration and no subscription changes.

A review bundle was generated at `/tmp/simplassist-voice-stage1-migrations.sql`, SHA-256 `663b7e78842190536193d7ab972693e892f00c045f2b079f34cf861f6e813a95`. Source migrations remain authoritative. If any migration changes, regenerate and retest the bundle before applying it. If application stops partway through, inspect which transaction committed; do not blindly replay already-applied CREATE statements.

Verify schema after application, using a securely loaded environment file:

```sh
node --env-file=/secure/path/simplassist.env scripts/voice-pilot-preflight.mjs --schema-only
```

The script performs reads only. It checks deployed columns and RPC exposure, private stream-credential access, the existing number assignment and bounded pilot settings. Database tests verify constraints and role restrictions; use catalog inspection if deployed SQL differs from the tested migration files.

## 2. Railway services and variables

Verified existing Railway project: `b716dd1c-1fe2-4504-968a-6028924c4a01`; production environment: `139950ab-eb69-4a35-86b4-d832f23cc4f8`.

- Application **SimplAssist**: `a0147f69-17f1-484a-a02d-e60e73b7c1d4`.
- Existing **simplassist-scan-worker**: `74515b09-ae6c-4f00-b9e4-3a273bb1db49`.
- New **simplassist-voice-worker**: `aec0a33c-df1a-4924-bf79-8678cb4f4eea`, created as an empty service. HTTPS endpoint: `https://simplassist-voice-worker-production.up.railway.app`. Build from this repository with the service settings in `deploy/voice-worker-settings.json`: a worker-only TypeScript build check, one replica, persistent Node 22 process, `npm run start:voice-worker` and `/health` health check.

Railway now [rejects Config as Code for new services](https://docs.railway.com/config-as-code). The original proposed `railway.voice-worker.toml` was replaced with explicit service settings; the existing app and scan-worker configuration files were not migrated. `deploy/voice-worker-settings.json` is a reviewable settings record for the Railway service API/dashboard, not an automatically loaded deployment file. A later project-wide IaC migration is separate work.

Do not change the scan worker's source or start command. Do not change the public number or Telnyx webhook URL: `https://simplassist.com/api/messaging/voice`.

### Application variables

| Variable | Value / source |
| --- | --- |
| `VOICE_PILOT_ROLLOUT` | `false` for initial deployment; later `true` only after schema and worker checks pass |
| `VOICE_SERVICE_URL` | Dedicated worker's public HTTPS origin |
| `VOICE_INTERNAL_TOKEN` | Random secret of at least 32 characters; same on worker |
| `VOICE_STREAM_SECRET` | Separate random secret of at least 32 characters; application only |
| `VOICE_AUDIO_PROFILE` | `pcm16`; must match worker |
| Existing Supabase, Telnyx and app URL variables | Retain existing production values |

### Voice-worker variables

| Variable | Value / source |
| --- | --- |
| `OPENAI_API_KEY` | API-project key with GPT-Live-1 access and `api.model.read` for readiness checks; configure securely, never in chat or Git |
| `ANTHROPIC_API_KEY` | Existing approved answering-provider access |
| `TELNYX_API_KEY` | Existing SimplAssist phone-provider access |
| `NEXT_PUBLIC_SUPABASE_URL` | Same database as the application |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-only database credential |
| `NEXT_PUBLIC_APP_URL` | `https://simplassist.com` |
| `VOICE_INTERNAL_TOKEN` | Matches application |
| `VOICE_AUDIO_PROFILE` | `pcm16` |
| `PORT` | Railway-provided port |

Prefer Railway variable references for existing shared credentials. The stream signing secret is not needed by the worker: it consumes a single-use credential through the database. Do not print variable values, stream URLs, provider responses containing download URLs, recordings or transcripts in logs.

The worker calls authenticated application maintenance every 15 seconds. A successful sweep within 90 seconds is required for readiness, including while pilot routing is off. Cleanup uses durable DB leases/retry state. Keep the application and maintenance worker running after disabling voice so audio expiry and unfinished call cleanup continue.

## 3. Deployment order and readiness

1. Apply and verify production migrations while voice remains disabled. Completed September 15 under Bryan's explicit one-time authorization.
2. Configure application variables with rollout `false` and deploy the application code. Confirm the existing health endpoint and exact Telnyx callback host remain reachable.
3. Configure and deploy the dedicated worker. The application must already contain `/api/internal/voice/maintenance` for the worker to become ready.
4. Verify `/health` and authenticated `/ready`; verify missing/bad auth is rejected on `/ready` and `/media`. The latter consumes only a stored, unexpired, one-use credential tied to the call, business, completed notice and starting phase. Never invent a production call to bypass admission.
5. Run full read-only preflight with required provider credentials and worker secrets securely loaded. Model lookup proves access, **not** audio quality or a completed voice session.
6. Set app rollout `true`, redeploy, then enter tester phone numbers in E.164 format through `/admin/voice`. The DB pilot setting stays disabled during these checks.
7. When service readiness is green and testers are saved, enable the pilot through the admin control. Leave the 200-minute budget and max-call settings at their approved defaults.
8. Complete one approved tester call and inspect its transcript, recording, provider IDs, outcome and usage. Complete a separate non-tester call to verify the legacy experience. Continue the structured acceptance set below.

If any readiness check fails, leave the pilot disabled. Do not substitute an unverified model or audio profile just to activate it. The compatibility profile is `pcmu8` on **both** services; enable it only after its own real-call verification.

## 4. Call review, budget and recovery

Open `/admin/voice` from the admin navigation. Add approved testers, see available/reserved minutes and call outcomes, and open any call for transcript fragments, authenticated audio, backend latency, provider cost estimates and feedback. Workspace voice conversation history is read-only and uses existing business-access rules.

- Each admission atomically reserves up to ten minutes from the **single 200-minute pilot pool**. It is not a monthly reset or billable customer allowance. Concurrent calls cannot reserve the same minutes.
- During a call, cumulative OpenAI usage uses the maximum received value; repeated snapshots are not added together. Final confirmed usage releases the unused reservation.
- If final usage is missing, show it as unconfirmed and retain the reservation. Use the call's admin reconciliation form only with actual provider evidence, recording the reference and billed seconds. There is no invented provider session-retrieval endpoint or automatic assumption of zero usage.
- A stream credential that was never consumed can be proved unused after expiry and closure; maintenance can then release that reservation.
- A completed Claude request is not evidence of spoken playback. Review the separate sent-audio/playback indicators and listen to the actual recording. Backend wait is not the same as phone playback latency.
- Recording proxy verifies account access and provider call identity, and never exposes a provider download URL. Audio access ends at 30 days even if provider deletion needs retries. The durable deletion job continues retrying; transcripts retain normal conversation-history behavior.
- Account cleanup disables voice, scrubs voice transcript/caller data and schedules provider audio removal. Late callbacks cannot restore scrubbed transcript content.
- One eligible text fallback uses the existing missed-call SMS eligibility, quota and idempotency checks. A normally completed voice interaction must not produce generic missed-call text. Declining voice because of capacity or budget preserves the legacy path.

### Cost estimate assumptions

Current estimate inputs, verified September 14, 2026:

- [OpenAI GPT-Live](https://developers.openai.com/api/docs/guides/voice-latency-cost): $0.05 per voice-session minute, including listening/waiting; billed by elapsed seconds.
- [Claude Haiku 4.5](https://platform.claude.com/docs/en/about-claude/pricing): $1 per million input tokens and $5 per million output tokens for uncached answering requests.
- [Telnyx Voice API](https://telnyx.com/pricing/voice-api): US inbound estimate $0.0052/minute (API plus starting SIP rate), streaming $0.0035/minute, recording $0.002/minute, and Polly Neural notice at $0.000024/character. Actual account rates and billable rounding may differ.

A full 200-minute OpenAI allocation is approximately $10 for GPT-Live alone. Add backend requests, phone streaming/recording, the notice and hosting. The UI shows estimates from received usage, not provider invoices; missing usage can make the total incomplete. No customer overage charging exists in Stage 1.

## 5. Structured real-call acceptance

Use short calls first to preserve the pool. Before each factual test, record the current approved facts and ask the equivalent question by SMS. Do not treat text wording as the requirement: the underlying business facts must agree. Use a tester device with a stopwatch or audio editor to measure from end of the question to the first useful **audible** answer and from caller interruption to a natural audible response.

| # | Test | Expected result |
| --- | --- | --- |
| 1 | Approved tester calls existing number | ~11 seconds ringing, AI/recording notice, then natural greeting |
| 2 | Non-tester calls | Current voicemail/text-back experience |
| 3 | Active service price | Correct current structured price; text agrees |
| 4 | Service changed before next question | Fresh approved fact is used |
| 5 | Overview conflicts with structured service | Structured service wins |
| 6 | Hours question | Correct approved hours; no guessed exceptions |
| 7 | Known FAQ/policy | Correct answer in concise spoken English |
| 8 | Missing price/policy | Clear acknowledgement that information is unavailable |
| 9 | Follow-up referring to previous question | Call-scoped context resolves the reference |
| 10 | Interrupt while assistant speaks | Natural interruption handling; no long stale playback |
| 11 | Correct service while backend is answering | Old result suppressed; updated question answered |
| 12 | Background noise / imperfect connection | Reasonable repeat/clarification; no invented facts |
| 13 | Ask to book or save an email | Explains Q&A-only pilot; no action claimed or saved |
| 14 | Ask about another customer's history | No private-history access |
| 15 | Hang up during ringing | Legacy abandonment behavior; no voice recording |
| 16 | Hang up after normal answer | One closed call, retained review, no generic missed-call SMS |
| 17 | Technical failure after notice (controlled test) | Clean closure and at most one eligible fallback SMS |
| 18 | Two concurrent testers plus third call | Two admitted; third keeps existing flow; no over-reservation |
| 19 | Admin stop during an active call | Active session ends safely; new calls use existing flow |
| 20 | Ten-minute and idle limits | Advance warning, bounded closure and explainable usage |

Also verify exhausted minutes in a controlled configuration with no paid overage, duplicate webhooks/callbacks in the harness, authenticated recording playback, audio retention retry visibility, and explicit PCMU compatibility calls if that profile will be used. Restore the approved budget only through an audited admin change.

For each call record: date/time, test number, call-review URL, expected facts, observed answer, seconds to useful playback, interruption delay, audible naturalness feedback, duplicate texts if any, recording/usage status, fix/retest link, and pass/fail. Use the feedback field for the summary; avoid copying private caller data into unrelated documents.

Acceptance: no invented business facts or completed actions in the set; voice/text factual agreement; target routine answers within three seconds and interruption handling within one second, measured at actual phone playback; every call's outcome and usage explainable; no competing generic missed-call texts. **Bryan approves naturalness after listening.** Failures become fixes and retests before broader exposure.

## 6. Rollback

Use **Stop pilot voice** in `/admin/voice`. It works independently of budget reconciliation, stops new pilot admissions immediately and is rechecked by active workers about every three seconds. For deployment rollback, also set application rollout to `false` and redeploy if needed. Preserve the voice callback code while active or late callbacks remain: it owns recording events and prevents them from entering the voicemail handler.

Keep maintenance available to drain sessions, reconcile usage and delete recordings. Do not remove tables, reset usage, erase history, alter the existing phone number, or restore a pre-voice app while unhandled voice callbacks remain. A provider outage may leave usage unconfirmed; retain the reservation until there is evidence to reconcile it.

## 7. Product roadmap after acceptance

Stage 2: improve voice quality and add name/email collection with read-back and confirmation, then calendar availability and booking through existing validated functions. Confirm service/date/time/contact details before booking; distinguish a request from a confirmed calendar event; test corrections, duplicates and uncertain provider results.

Stage 3: voice exclusively for Pro / Full Suite. Keep the $45 tier text-only. Top-tier users select **Text follow-up** or **AI voice answering** as the primary unanswered-call response, with optional eligible text fallback. Add monthly included voice minutes, usage visibility and approaching-limit warnings. Choose allowance and pricing from pilot measurements, add clearly priced opted-in overage only after billing is verified, and test downgrades/cancellations/margins before a small customer rollout and general availability.

These stages are recorded commitments for the later product; Stage 1 approval does not implement commercial billing or voice booking.

## Deployment / acceptance record

- Production migrations (September 15): applied the exact reviewed bundle for 069–072 to project `inmgpkurctttsofpywuz` using the authenticated Supabase CLI. Separate read-only catalog verification matched all 16 function definitions to the tested SQL and verified RLS, service-only callable RPCs, validated foreign keys, triggers and voice-channel constraints. Application API schema preflight passed. Supabase migration history was then repaired for only 069–072 and read back. Immediately after migration verification, the pilot was disabled with 12,000 seconds, two simultaneous calls, a 600-second call limit, no testers and no sessions. Existing contacts/conversations/messages counts and the active `sms_and_chat` subscription were unchanged.
- Railway login: verified through official CLI.
- OpenAI setup (September 15): Bryan created a dedicated key in the SimplAssist OpenAI project, replaced `OPENAI_API_KEY` on the Railway voice worker and applied the change. The worker key now successfully reads `gpt-live-1` (HTTP 200). The earlier reused key's model-read denial is resolved. No key was displayed, stored in Git, or added to the local project environment. Model lookup confirms model access; real voice-session behavior still requires phone testing.
- Voice worker (September 15): Railway deployment `c8d19e49-dfe7-4a46-92fa-99d0bb3eaa8b` is `SUCCESS`, using committed source `0821aa1`. The upload excludes the app and scan-worker Railway TOML files so the saved voice-service settings control the build and start command. `/health` and authenticated `/ready` return 200 with `ready: true`, `gpt-live-1`, `pcm16` and zero active calls. Missing/invalid readiness credentials return 404; missing/invalid WebSocket media credentials return 401. Full read-only provider/schema/tester preflight passes, including authenticated durable maintenance. No real caller session had been opened at the readiness check; actual call acceptance is still pending.
- Application deployment (September 15): final Railway deployment `b65a3fe2-ebd9-43ef-863b-be5647ff7685` is `SUCCESS`, replacing the default-off deployment `e48d43f8-6340-4c65-b03e-35e3d0050118`. Both use a clean Git archive of `0821aa1` (archive SHA-256 `562d0b8695368e599cd497a0df8358a4ea9b96970214ce8c09f8185b58ef7c6b`), excluding local environments, dependencies and build artifacts. Application rollout is now `true`, after the worker and full preflight passed. Apex and www health checks returned 200. The protected admin page showed Service Ready and allowed pilot enablement. Subsequent admin page requests returned HTTP 200 in Railway logs. A stable post-save browser observation was interrupted by concurrent browser activity; activation itself was confirmed by separate DB read-back. The app's GitHub source remains `main`; this was a one-off feature-branch upload, so a subsequent main deployment would replace this build. The scan worker was not redeployed or reconfigured.
- Pilot activation (September 15, 14:33 UTC): enabled through the authenticated production `/admin/voice` controls after service readiness passed. Separate DB read-back confirmed settings revision 3, enabled=true, exactly the one caller number explicitly supplied by Bryan, 12,000 seconds, max two simultaneous calls and 600 seconds per call. Account operational checks and the active `sms_and_chat` subscription passed before activation. Usage, active calls and unconfirmed calls were zero at activation. Keep private caller numbers in pilot storage, not this document.
- First real call: Bryan reported that the assistant sounded amazing and that he liked its attention to detail. His requested follow-up is a natural business-name greeting in the same voice. This is positive user feedback, not completion of the 20-call acceptance set or a verification of every call record.


## Natural greeting follow-up (September 15, deployed)

Requested greeting: “Hi, this is [business name]. How are you doing today?”
The worker loads the called business's saved name and asks Marin to speak this
once, then listen. GPT-Live may vary wording or be interrupted; acknowledgment
of the instruction is not proof of exact audible playback.

Migration 073 separates prior tester disclosure acknowledgment from a notice
actually played on a call. Only a currently approved tester with a recorded
prior acknowledgment can skip the separate Polly announcement. That prior
acknowledgment must cover AI use, audio recording/30-day retention, and saved
transcripts, and must predate the call. Tester membership, an Indiana business
address, or a phone area code never substitutes for acknowledgment. No tester is
acknowledged by the migration itself. New/re-added testers default to the existing
notice. Ordinary label/budget edits preserve acknowledgment for retained testers.

Recording, transcript retention, the 11-second ring, routing limits, and the
non-tester text/voicemail flow remain as before. Calls without the Polly notice
no longer include its estimated speech cost. The admin call page distinguishes
prior acknowledgment from a played notice.

Bryan explicitly approved applying migration 073, recording his existing
acknowledgment, and deploying this change. Production read-back matched all five
function bodies and their fixed search paths/service-only permissions; all three
new columns and migration history are verified. Only the existing owner tester
has a prior acknowledgment, with an audit entry. Pilot revision 3, 12,000 seconds,
two concurrent calls, and 600 seconds per call remain unchanged.

- Source commit: `21c92e9918d769fef7938f65b99571379a7352ac`.
- Migration SHA-256: `5b960e51d367d88ba61694c4e7bb8096f4795c11951cf45d37c426c4a5f63b63`.
- Railway worker: `c59990d8-909d-4fb8-85b2-f8d452a2f6fd`, SUCCESS.
- Railway app: `9e5d1da7-b2f2-4567-8eef-2b633bb8933d`, SUCCESS.
- Checks: 388 targeted unit/integration tests, 61 SQL files / 2,763 assertions,
  Next build, worker TypeScript, ESLint, local REST recovery filter, production
  read-only preflight, authenticated maintenance/worker readiness all pass.
  Unauthenticated worker readiness returns 404.
- The new greeting still needs Bryan's next real inbound call to verify how it
  sounds. The earlier successful call used the previous opening.

The migration and greeting are deployed; do not expand this private-test behavior
to public callers as part of this change. To restore the spoken announcement for
a tester, clear that tester's prior acknowledgment or remove and re-add the tester.
Keep call history intact. The short greeting remains in Marin after any notice.
The application is still a feature-source upload; a future deployment of the old
main branch would replace this pilot version.
