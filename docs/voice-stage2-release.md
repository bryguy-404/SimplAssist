# Private voice actions: release and call tests

## Current scope

Use the existing SimplAssist account and (574) 263-8634 number. Only the existing approved tester enters voice. Add confirmed contact capture and permission-based signup SMS. No separate account, Telnyx onboarding, or calendar setup is needed for this release. Booking and demo routes stay disabled; calendar foundations are not phone-accepted or ready for customer rollout.

The signup destination is `https://simplassist.com/signup`, the existing homepage Get Started destination. The assistant offers to text it, asks permission, and sends it only to the calling number. It does not read a long URL. If texting is declined or unavailable, explain that the caller can visit simplassist.com and choose Get Started. Name/email are optional for signup and are not a gate to receiving the link.

## Verified locally

- 69 targeted suites / 1,606 tests pass across voice, text AI, calendar, messaging, billing usage, webhooks, and admin/internal routes.
- 63 local database files / 2,797 assertions pass, including role restrictions, business scoping, actual playback/confirmation evidence, atomic contact saves, corrections and preparation accounting.
- Admin controls and action review checked in a browser against an isolated local Supabase fixture. Controls are disabled when the worker is unavailable. Review distinguishes accepted/delivered texts from completed signup. No browser errors observed on the verified pages.
- Application production build and worker TypeScript checks pass. Live call acceptance remains outstanding.

## Deployment order

1. Bryan applies `docs/sql/voice-stage2-schema.sql` in the correct production Supabase SQL editor. This is one transaction containing canonical migrations 074–076. Apply once; do not run it again after success. It leaves all new capabilities off and preserves the current Q&A pilot settings, tester list, subscription, budget and call limits. If applied using the SQL editor, record/repair CLI migration history through the existing approved workflow; do not blindly push the three migrations afterward.
2. Catalog-verify the new tables, RLS/grants, functions and default-off fields. Use `supabase/migrations/074_voice_actions.sql`, `075_voice_action_controls.sql`, `076_voice_preparation.sql` as the canonical definitions.
3. Bryan applies `docs/sql/voice-stage2-signup-goal.sql` (or sets Signup + the same URL in the existing business settings). This intentionally changes the shared text/voice business goal from Book to Signup. It does not activate voice actions. Verify read-only afterward.
4. Create clean private deployment archives from the reviewed feature branch. Do not push private operational notes to the public Git remote. Deploy voice worker and app with `VOICE_ACTIONS_ROLLOUT=false` first. Keep the scan worker untouched. Worker archive follows the existing separate-worker build/start configuration.
5. Verify app health, worker authenticated readiness, matching internal token and application URL. Set `VOICE_ACTIONS_ROLLOUT=true` on worker first, confirm `/ready` advertises `actionProtocol:1`, then on app. No new API key is needed; retain existing OpenAI/Anthropic/Telnyx credentials privately in Railway.
6. In `/admin/voice`, enable confirmed contact saving and signup link texts only after readiness passes. Keep booking off (not exposed by this release's API/UI). Enable preparation during ringing separately and compare greeting latency with it off/on; preparation consumes the existing minute allowance, including abandoned-call provider time.
7. Verify current approved tester only, no new demo route, same 200-minute budget/two calls/ten minutes, same $45 subscription, correct goal URL, and SMS provider readiness/opt-out checks. Run the calls below before declaring the new flow ready.

The migration handoff follows `docs/PROJECT_LOG.md`, Working agreements: “Migration first; Bryan pushes prod himself.” No new production migrations, goal changes or deployments are claimed complete by these local checks.

## Twenty-call acceptance set

Review each call in `/admin/voice`: transcript/recording, contact details, action status, actual received SMS, provider delivery outcome, usage and feedback.

1. Known FAQ; answer accurately, offer a signup step only when relevant.
2. Unknown question; admit missing information, no invented promises.
3. Interested caller; ask permission, text the approved link once.
4. Decline text; no SMS, give simple website/Get Started instructions.
5. Ask to send to another number; explain this pilot sends only to calling number.
6. “Yes, but…” correction; no send until fresh clear confirmation.
7. Interrupt permission readback; do not send on partial/interrupted confirmation.
8. Correct name before confirmation; save only the confirmed version.
9. Spell/correct email; read back, save confirmed value.
10. Decline email; continue help, do not block signup link.
11. Existing contact has different name/email; retain old canonical values, show confirmed call details/conflict for review.
12. Repeat “send it”; same successful request must not create duplicate texts.
13. Ask whether signup is complete; distinguish link sent from actual signup.
14. Ask for booking; explain current capability without claiming an appointment.
15. SMS opted out/provider unavailable; no bypass, use simple website fallback.
16. Pause texting/disable signup while call active; prevent new sends.
17. Provider response uncertain (controlled failure); no blind resend, review status.
18. Hang up during ringing/preparation; provider session closes, usage stays explainable.
19. Compare silent gap/ringing with preparation off and on; no prepared speech leaks before attachment, no duplicate greeting.
20. Non-tester call; preserve the existing voicemail/text-back experience.

Use controlled local fault injection for destructive/failure cases before attempting a live scenario. Do not send unsolicited test messages or invite real calendar attendees. Bryan judges naturalness; measure actual phone playback, not just backend completion. Record failures, fix and retest. Live calendar acceptance is a separate later gate.

## Rollback

Disable action capabilities to return voice to Q&A. Disable preparation to return to the existing bounded startup path. Disable the overall pilot if necessary to return subsequent calls to the existing text-back flow. Do not remove action records, replay uncertain sends, or roll back schema while sessions are active. Preserve the signup goal unless Bryan explicitly wants to restore Book. Full top-tier access, monthly minutes and commercial overage rules remain Stage 3.

## Review commits and handoff status

- `ead3281`: action ledger and confirmation boundaries.
- `34311ae`: confirmed contact/signup execution, SMS bookkeeping and recovery, restricted booking foundation.
- `bf5fbe4`: admin capability controls and action review.
- `10e9725`: delegated decisions, playback acknowledgments and optional provider preparation during ringing.

The goal-change SQL was executed against the isolated local fixture and rolled back; it produced Signup + the intended URL. The schema bundle consists of the tested canonical migration bodies inside one transaction. Production database work, private deployments and capability activation were subsequently completed and verified as recorded below. Real-call acceptance remains pending.

## Production database update — September 15, 2026

Bryan explicitly authorized Codex to apply the Supabase steps in this task, overriding the default manual migration handoff for this update. Applied migrations 074–076, their history entries, and the approved Signup goal in one transaction using the authenticated Supabase CLI for project `inmgpkurctttsofpywuz`. A separate read-only query verified all three history entries, both new tables with RLS, eight server-only functions, blocked client writes, the Signup URL, one existing approved tester, and unchanged 200-minute/two-call/ten-minute limits. All new capability switches remain off. Existing app and voice health checks pass; no active calls were present. No application deployment or live action acceptance is included in this database verification.


## Production deployment and activation — September 15, 2026

Bryan authorized the remaining implementation. Deployed clean private archives of `1097a56a55ac39b55b7740fc71eeaec802e0f1c2` (source archive SHA-256 `8b5bd54a400f113e38bc823da49bc47bca833d02ae8f279cb7f8166a9c2897cc`). No public Git push.

- App final deployment: `f60a441b-0849-49b5-86b5-90d7478be6eb`, SUCCESS.
- Voice worker final deployment: `cecdb561-b39c-4103-aac5-1c156f8bd64f`, SUCCESS.
- Scan worker remains `12c2582a-2263-4055-92a8-1f4eaf27c642`; no changes.
- Both services first deployed with actions disabled; then enabled `VOICE_ACTIONS_ROLLOUT` on the worker, verified live `actionProtocol:1`, and enabled it on the app.
- Account revision 4: contacts/signup on; booking/preparation off; no demo route. The optional preparation experiment remains off for the first signup tests, preserving the already-tested opening behavior.
- One approved tester, original phone, 200 total minutes, two simultaneous calls, ten-minute limit and active `sms_and_chat` subscription remain in place. No billing upgrade or overage change.
- `configure_voice_actions` used the existing verified staff admin identity (separate from the business owner login). A separate read-only CLI database session verified the result.

Live checks passed: app health 200; authenticated worker readiness 200; action protocol 1; internal credentials match; unauthorized readiness/actions return 404; invalid stream credentials return 401; authenticated nonexistent-call context is rejected. OpenAI/Anthropic model access, Telnyx callback routing and durable maintenance passed preflight. Read-only SMS checks confirmed correct phone assignment, carrier readiness, operational access and no tester opt-out. The account had 120 of 1,500 SMS parts used at verification. No SMS was sent by deployment checks.

The pilot is ready for Bryan's first real signup/contact call. No voice action has yet been phone-accepted in this release; the twenty-call acceptance set above remains outstanding. Review resulting calls at `https://simplassist.com/admin/voice`. A delivered signup link is not a completed signup. Keep wider release and booking disabled until their own acceptance gates pass.


## Proactive receptionist guidance — September 15, 2026

Bryan requested that the assistant initiate contact collection after the caller agrees to the relevant next step. Shared speaking/delegation guidance now asks for name, then email, skips details already provided in this call, reads back and confirms before saving, then continues to signup permission without waiting for the caller to ask. Refusals are respected; contact capture is not a gate to receiving the link. Contact-save assent and SMS permission stay separate. Booking remains disabled.

Verified the existing dashboard path: confirmed details fill `contacts.name`/`contacts.email` and appear in Contacts and the conversation header. Existing different canonical details are preserved; new confirmed details remain in the call action record/transcript for review. No database or dashboard schema changes were needed.

Local voice regression: 9 files / 71 tests passed; voice-worker TypeScript check passed. Optional isolated live-model evaluation was blocked by automatic approval review before execution because it would send proprietary voice instructions to Anthropic. No external model evaluation was performed; naturalness and the live collection flow still require a phone test.

Proactive guidance deployed privately from `257338f0a53dcd4a2ba13ce8763563f0b0f7a911` to voice worker deployment `526e5de4-7821-4bf1-9231-b89b817d4353` (SUCCESS). App remains `f60a441b-0849-49b5-86b5-90d7478be6eb`; scan worker unchanged. Post-deployment app health/worker readiness returned 200, protocol 1 was active, unauthorized endpoints stayed 404, and nonexistent-call context remained rejected. No active calls at deployment checks. No migrations, capability changes, or contact mutations were performed in this guidance update. Ready for Bryan's conversational phone test.

## Signup call recovery and fallback deduplication — September 15, 2026

The private signup test ended with `backend_failed` after approximately 102 seconds, below the ten-minute limit. The final delegated model response had confirmed usage, but no contact or signup action was persisted. The original logs do not identify whether decision validation or the action endpoint rejected that request; do not claim a more specific cause. Two identical generic fallback messages were persisted 379 milliseconds apart. Code inspection found an unclaimed read/send/write fallback path shared by webhook and maintenance recovery.

Changes:

- Backend failure/timeout now explains the difficulty and keeps the phone conversation open. It does not automatically replay an uncertain action. A caller-requested retry loads current action state; three consecutive failures stop further backend requests for that call, with an honest explanation. Existing idle, maximum-duration and operational limits remain.
- Shared receptionist guidance explicitly offers to text the signup link, only gives the short website as a fallback, and requires a stored proposal before reading contact details back for permission. Contact-save and texting permissions remain separate; refusals are respected.
- Diagnostic logs identify the failing stage and allowlisted error categories without model outputs, transcripts, emails, phone numbers, keys or recording URLs.
- Migration 077 adds a durable fallback delivery claim and error marker. The claim is acquired atomically after messaging eligibility checks and before provider submission. SDK retries are disabled only for this voice fallback path. Preflight failures remain retryable; a claimed but uncompleted send requires provider review and must never be blindly resent or have its claim automatically released. Maintenance excludes claimed sends. A blocked concurrent preflight cannot complete another handler's active delivery.

Verification: 1,330 regression tests across 59 files; final focused run 93 tests across 11 files after the final concurrency guard; worker TypeScript and application production build passed. The isolated local database suite passed 64 files / 2,802 assertions, including migration 077 and claim behavior. Mocked model responses test strict decision validation and safe failure diagnostics; no external model evaluation or automated customer SMS was performed. Booking remains disabled. The next real call must verify a proactive offer, confirmed contact capture, signup-link delivery and no duplicate generic fallback messages. Deployment details follow after verification.

Production verification: migration 077 and its history entry were applied atomically, then independently verified through a read-only CLI session. Both claim columns exist; anonymous/customer writes remain denied. Contacts/signup remain enabled at revision 4, booking disabled, 12,000-second pilot budget unchanged, goal Signup with the approved URL. No active calls were present.

Deployed private archives of `335e4434bd85600cda084bf169f251aaa207f2b4`, SHA-256 `cc20b1c87a0c4ed1b611dee4282853cc851b9346d30d25a1492ea9237ccb0f9a`:

- Voice worker: `a3ca449a-7598-4650-92b8-75aaab022133`, SUCCESS.
- App: `3f8fa167-3fa1-44de-9c98-812431bc055f`, SUCCESS.
- Scan worker unchanged at `12c2582a-2263-4055-92a8-1f4eaf27c642`.

Post-deployment app health and authenticated worker readiness returned 200; readiness true, action protocol 1, matching internal credentials, actions enabled in both services, zero active calls. Unauthenticated readiness/action requests remained 404 and authenticated nonexistent-call access was rejected. No customer message was sent by deployment or verification. The historical final contact-step rejection cannot be reconstructed from old logs; the next caller test must establish actual contact-save and signup-link success. Do not claim live acceptance from mocked tests or healthy deployment status alone.

## Spoken signup confirmation loop — September 15, 2026

The next tester call ended normally (`caller_hangup`) but repeated the signup permission question. Its pending signup proposal had a recorded playback acknowledgment; no action was executed and no signup text was submitted. The caller said “Yes, that works” and then “Yes, please.” Local regression tests reproduced rejection of both: the strict assent expression did not recognize the first phrase and rejected punctuation inside the second. Joining transcript deltas with inserted spaces also risked breaking words split across deltas. After rejecting assent, the response omitted the action ID needed to track a fresh readback.

The confirmation parser now normalizes spoken punctuation/whitespace and curly apostrophes, recognizes common standalone affirmations, and preserves all qualifying words and question marks. Corrections, conditional replies, refusals, quoted assent and questions stay blocked. Raw transcript deltas are concatenated without adding characters. A legitimately repeated confirmation includes the pending action ID and exact readback, allowing the phone bridge to acknowledge the new question. Safe diagnostic categories distinguish unclear assent from playback/evidence rejection. Voice guidance explicitly avoids “sending it now” until the backend confirms submission.

Tests cover both phrases from this call, a split-word confirmation, exactly one provider submission after duplicate confirmation, ambiguous replies, and replacement playback evidence after a repeated question. Regression: 59 files / 1,352 tests passed; worker TypeScript passed. Production build/deployment verification follows below. No database migration, billing change, booking enablement, or automated customer SMS is part of this fix.

Confirmation-loop fix deployment verified: production build passed. Deployed clean private archives of `e16ebcbd6ca3014426f452d3786f08ea1500420e` (SHA-256 `40d4eb30500c61a63f52efa44c53aec4e65e9ab0ef2bf163806e601e628b620b`) to app `162bd7a1-09b7-4a2c-a628-5621135b3382` and voice worker `3ca42492-eff9-4cd9-b737-1525e7f9ab0a`; both SUCCESS. Scan worker unchanged. Post-deployment app health and authenticated voice readiness returned 200, readiness true, protocol 1, matching internal credentials and zero active calls. Unauthenticated endpoints remained 404 and nonexistent-call access stayed rejected. No provider text was sent by these checks. Caller verification of actual signup-link delivery remains the next acceptance step.

## Contextual contact permission — September 15, 2026

The next call reached a contact proposal but did not execute it or submit a signup SMS. The app logged `assent_not_clear`; the caller's full response was “Yes, that-that's correct,” followed by “Yes, you can save those.” The worker also logged a later model-stage request failure; the older generic category does not conclusively distinguish provider timeout from other model-request failures. The prior phrase-list fix was insufficient.

Replaced the finite phrase gate with the existing answering model's contextual `confirm` decision. Instructions now explicitly require unconditional permission for the exact current action, evaluating the complete spoken readback and whole reply, including fillers/stutters. Questions, refusals, hesitation, conditions and corrections must produce an answer or corrected proposal, not confirmation. A reply to a different question cannot authorize this action. This remains probabilistic language interpretation and requires real-call acceptance; local mocked tests do not prove language accuracy.

The application independently requires nonempty, exact, duplicate-free coverage of every caller fragment after the current playback acknowledgment and within the current spoken-response window. Migration 078 repeats the complete-coverage check under the same session lock used by transcript persistence, preserving actual-playback, call/action isolation, ordering, latest-reply, operational access and one-time-execution checks. This prevents omission of a condition or a newly arrived correction. A delayed older fragment does not enter the current response window.

Reduced confirmation output to the stored playback event anchor for assistant audio rather than a long list of assistant word IDs; the model must still verify every spoken detail from the full transcript. Caller evidence must remain complete. Action-enabled model requests have a bounded 12-second deadline, no automatic retries, and propagate cancellation within the existing 35-second outer limit. Truncated model output cannot execute an action. Diagnostics distinguish real SDK timeout instances without logging transcript/provider response bodies. Speaking guidance also forbids premature claims that details are being saved or text is being sent.

Verification: 59 regression files / 1,345 tests, worker TypeScript and production build passed. Isolated database harness: 65 files / 2,821 assertions, including 19 new confirmation-coverage checks. Tests include natural contact permission, stutters, one execution, missing/partial/stale/cross-call evidence, late corrections, delayed earlier fragments, complete readback anchors, cancellation and real SDK timeout classification. No external model evaluation or automatic customer text was sent. Booking remains disabled. Production verification follows below.

Production rollout verified: migration 078 applied with its history entry and independently checked for whole-response coverage, server-only execution privileges, no active calls, and unchanged revision-4 signup/contact pilot with booking off and 12,000-second budget. Private source archive `462929869bcab59b275ea881abd441245278eb41`, SHA-256 `71b48bac4256a81793603445a99ae31241bdc5364f874b7a417a23764b0735e1`, deployed to app `4de51f37-30a0-40c9-a3f3-4f9b72ed1c3f` and worker `b9e7d001-088a-4bed-978c-55b957a1bbf7`, both SUCCESS. Initial worker upload exited before creating a new deployment; status verification preceded the successful retry. Scan worker unchanged. Final app health/authenticated worker readiness returned 200, readiness true, protocol 1, matching internal credentials, zero active calls; unauthenticated endpoints remained 404 and nonexistent-call context was rejected. No automated provider text or model evaluation was performed. The next real call must verify that contact details actually save and the signup SMS arrives; this release is not broader product acceptance.

## Compact voice action evidence — September 15, 2026

The latest call collected contact details but created no action. Production app diagnostics show `proposal_rejected/request transcript evidence missing` on the first attempt; the worker logged `decision_execution/backend_request_failed`, then `decision_validation/incomplete_model_output` on the caller-requested retry. This is an evidence-reference rejection followed by truncated model output, not a confirmed save-RPC failure or inability to understand the caller's assent. The failed model payload was not retained, so the exact erroneous reference is unavailable.

The worker now captures structured transcript fragments for each delegation and presents numbered speech segments to the answering model. It concatenates original deltas exactly, quotes untrusted speech, retains complete context lines, and maps selected caller segments back to original provider IDs locally. Model output no longer copies raw IDs. Confirmation's playback anchor is derived from the selected stored pending action; model-facing state contains its segment location instead. Role changes, gaps, fragment limits, pending caller cutoffs and playback markers split presentation groups. Grouping never asserts that a spoken turn is complete.

Unknown, duplicate, fractional, assistant and omitted/truncated segment references cannot become caller evidence. Expansions over the existing 100-event limit fail closed. The application API and locked database whole-response checks remain unchanged, including later corrections, call isolation, permission after playback, separate contact/SMS confirmation, and one-time execution. No automatic model or action retries were introduced. Full spoken readback and caller meaning still require the model's contextual interpretation; this change does not claim deterministic understanding of arbitrary speech.

Local-only analysis of this call reduced model transcript context from 16,316 characters/221 provider fragments to 2,411 characters/23 speech segments, with no external model replay. Verification: 61 unit/integration regression files / 1,371 tests; voice-worker TypeScript and production build passed. Complete isolated database suite: 66 files / 2,844 assertions, including 23 checks for fragmented contact proposal, real contact saving, duplicate claims/saves, separate signup permission and late corrections. No migration, production data edit or automated text is required. Only the voice worker needs deployment; the existing app action API is compatible. Live contact saving and actual signup SMS arrival remain the acceptance step.

Deployment verified: private source archive `cadd763f254dd17a918bd9bd9427a5deed957780` (SHA-256 `ef24e998f743e61f7300d47998f8f6f521791a7be33b2750739b234cc635f7f2`) deployed to voice worker `1a292570-eac6-4394-8cfa-c39861e987e2`, SUCCESS. Main application `4de51f37-30a0-40c9-a3f3-4f9b72ed1c3f` and scan worker remained unchanged. After successful rollout, application health and authenticated worker readiness returned 200, readiness true, action protocol 1, matching credentials and zero active calls. Unauthenticated endpoints remained 404; nonexistent-call access remained rejected. No database change or automated SMS/model evaluation was performed. Bryan's next call must verify saved contact details and actual signup-link delivery.

## Signup continuation and silence recovery — September 16, 2026

The latest call successfully saved the confirmed name and email; production contact fields match the action payload and there were no conflicts. The speaker acknowledged the save, waited, then asked about texting without a stored signup proposal. The caller agreed, but the conversation drifted into a generic offer to answer questions. No signup action or text submission exists for that call. Application/worker logs show no backend error. A trailing nonverbal transcript fragment arrived after the last backend request began; existing logs cannot establish whether its result was discarded or what decision text the model returned. Do not describe this incident as a failed contact save.

Contact success now leads directly to a server-prepared signup permission question when the current account goal and capabilities allow it. The completed contact stays successful if preparing the next step fails. Migration 079 serializes this transition using the existing call lock, derives request evidence from the saved contact action, checks account/call/goal access, and preserves separate signup readback and fresh caller permission. It cannot send a text or copy contact consent. Repeated continuation reuses the pending offer, while newer requests and attempted SMS actions remain protected. A narrowly guarded, never-executed superseded signup can receive a fresh revision/readback after a corrected contact save; previous playback and consent do not carry forward.

An explicit `readback` decision returns stored pending wording and its action ID, so a result discarded before speech can be recovered with proper playback tracking. Previously a plain answer repeating a permission question did not arm tracking. The main app must deploy before the worker because it validates this new decision variant; rollback should reverse that order.

The voice bridge drains current persistence before capturing transcript and caller generation together. Any caller fragment arriving after that snapshot, including late/out-of-order fragments hidden by provider offsets, requires fresh interpretation. Discarded responses preserve the existing task instead of inviting an unrelated question. If a current response or stale-result instruction produces no audible output, caller speech, or fresh delegation, one five-second conversational nudge resumes the task; it does not execute or retry a backend action. New activity and closure cancel the nudge. Safe decision/lifecycle diagnostics record IDs, intent, counts and timing without caller details or response text.

Live SMS readiness, number assignment, operational access and tester opt-out checks passed without sending a message. Pilot settings remain enabled revision 4, 12,000-second budget, contacts/signup on, booking off. Automated verification and rollout results follow below; real conversation quality and actual signup SMS arrival still need the next phone test.

Final verification: 61 unit/integration regression files / 1,403 tests; worker TypeScript and production build passed. The complete isolated database harness passed 67 files / 2,947 assertions, including 103 checks for migration 079. Coverage includes fresh SMS consent, atomic pending-offer reuse, guarded correction rearm, denied attempted-send reuse, stale/newer actions, missing playback recovery, queue-delay snapshot races, late/out-of-order speech, and one-shot silent-result nudges with no automatic backend replay. No external model replay or automatic customer text was used. Migration 079's tested canonical MD5 is `611679aef304c24ffd71b4797dc5cf85`; production verification and deployment identifiers follow below.

Migration 079 applied transactionally and its history MD5, security-definer setting, service-role execution and denied anonymous/customer execution were verified. Settings stayed at revision 4 and no calls were active. An authenticated PostgREST check against a nonexistent call returned its expected all-null composite; the service normalizes that representation as no continuation, with a regression test. The function is visible through the production API. No customer record was targeted by this check.

Production rollout verified: private source archive `6b5f4d554e9194e844a32f7eea630ecc91629b8f` (SHA-256 `3e5abc4f656e06ac116b28d60a7acd2eb5243effed8b1a77454f63187dc34659`) deployed first to app `340617f6-2425-4b53-94a5-cf4392e36399`, then worker `d7c7c49e-0048-4111-b3ef-a2d29758de04`; both SUCCESS. Scan worker unchanged. Final app health and authenticated worker readiness returned 200, readiness true, matching credentials, action protocol 1 and zero active calls. Unauthenticated endpoints stayed 404 and nonexistent-call context was rejected. Migration 079 and the private tester restrictions remain in place. No automated signup SMS was sent. The next real call must confirm the saved-contact acknowledgment flows into the prepared text-permission question and that exactly one signup SMS actually arrives.

## Natural follow-up after sending a signup text — September 16, 2026

Bryan's next call saved contact details and submitted the signup text successfully, and he confirmed receiving the link. He approved the tone, speed and collection flow. The ending transcript shows the assistant announced submission without inviting a receipt acknowledgment; after Bryan volunteered receipt, it only acknowledged it and waited. This is a conversational follow-up gap, not a failed send.

The shared speaking/answering guidance now invites the caller to say when the text arrives after verified submission, then acknowledges receipt and offers further help once in the same response. The model chooses its wording; this is not a fixed spoken script. Receipt acknowledgment is conversational, not authorization for another action. New questions and clear goodbyes take precedence; repeated checks, automatic resending and claims of completed signup remain prohibited. The style guidance explicitly permits this task-specific follow-up. Contact collection, permissions, send execution, timing, voice and business knowledge are unchanged.

Verification: all 12 voice test files / 152 tests passed, voice-worker TypeScript passed, and the diff passed whitespace checks and a separate read-only review. No new brittle prompt-string tests, database change, external model replay or automated customer SMS were needed. Only the voice worker requires deployment. Naturalness of the revised ending still needs a phone test; deployment verification follows below.

Production rollout verified: private archive `e36c53ed892cfa3fe8c659d3577afb45f701f556` (SHA-256 `1f5af4938dc40d8bf51c7e88f7526da459183f469ae1d77778374223ce68e37e`) deployed to voice worker `4248e781-a9e3-482d-a5d6-8f6d4c97cbca`, SUCCESS. App `340617f6-2425-4b53-94a5-cf4392e36399` and scan worker `12c2582a-2263-4055-92a8-1f4eaf27c642` remain unchanged. Post-deployment app health and authenticated worker readiness returned 200; readiness true, action protocol 1, matching credentials and zero active calls. Unauthenticated endpoints remained 404 and nonexistent-call access was rejected. Pilot access and capabilities were not changed. The next phone test should check the receipt invitation and one natural further-help offer after receipt, including honoring a caller who is already finished.

## Whole-response confirmation evidence — September 16, 2026

The next call's first contact-save assent was transcribed clearly as “Yes, that's fine.” The worker rejected it at `decision_validation / invalid_transcript_evidence` before submitting any action; it was not a timeout. A repeated readback and fresh assent succeeded, the signup SMS was marked delivered, and the new receipt/further-help ending worked. The older diagnostic grouped several causes together, and the replacement readback overwrote the initial playback fields, so the precise original invalid reference or missing prerequisite cannot be established.

The model now returns its semantic confirmation decision and the existing pending action ID without copying numbered confirmation segments. The worker derives the complete caller response from the same immutable transcript snapshot the model saw, beginning at that action's playback cutoff. It rejects empty, duplicate, oversized, or partially hidden/truncated evidence. The model is shown the full reply's segment locations and must still judge unconditional permission for the complete, uninterrupted readback. Conditions and corrections must not authorize an action. No extra model request or automatic action retry was added.

The application and locked database checks remain authoritative for actual playback, receipt time, complete response coverage, later corrections, current action identity, separate contact/SMS consent and one-time execution. No newer database speech is added to an older model decision. Worker-to-app action contracts are unchanged. Typed, allowlisted error reasons now distinguish missing/wrong action state, playback prerequisites, hidden reply evidence and segment errors without retaining model output or caller details.

A local bridge reproduction also demonstrated that a phone playback acknowledgment arriving after caller speech is conservatively rejected. This is not proven to have occurred in the incident. That safety gate and its timing remain unchanged; new playback diagnostics distinguish accepted marks, caller advancement, stale actions and closing calls using only IDs, numeric offsets and allowlisted categories.

Verification: all 386 unit/integration test files / 6,538 tests passed; voice-worker TypeScript and the production application build passed. The build used a nonfunctional local Resend placeholder solely to satisfy its existing import-time constructor. Four isolated local database files / 171 assertions passed for voice actions, full confirmation coverage, segmented actions and signup continuation. Tests include fragmented assent, fillers/corrections, truncation, missing/stale playback, duplicate evidence, immutable snapshots, private diagnostics and delayed playback acknowledgments. A separate read-only review found no blocking issues. No production database change, external model replay or automated customer SMS was used. Only the voice worker requires deployment. The next call must verify the first clear assent proceeds smoothly; this change does not establish the historical subcause or guarantee live model interpretation.

Deployment verified: private source archive `fdb6a64cfcece9495afa6fa3d1747962c1f8b154` (SHA-256 `f93c478376aa85e8b2035c977a9794553d6a7f58c85aff0502801c70b08273a3`) deployed to voice worker `5624ebab-c00e-41d3-88d0-328324c7a993`, SUCCESS. App remains `340617f6-2425-4b53-94a5-cf4392e36399` and scan worker remains `12c2582a-2263-4055-92a8-1f4eaf27c642`. Final app health and authenticated worker readiness returned 200, readiness true, action protocol 1, matching credentials and zero active calls. Unauthenticated readiness/actions stayed 404 and nonexistent-call access was rejected. Existing private pilot restrictions, tone, speech timing, contact/signup capabilities and booking-disabled configuration remain in place. Ready for the next real confirmation and signup call.
