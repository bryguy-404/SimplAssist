# Voice transcript display and message-count correction

## Approved scope

Bryan approved fixing word-by-word voice transcript bubbles and the inflated Messages Sent statistic. Baseline `11fc445`; branch `codex/voice-transcript-display`. Keep existing raw call evidence, audio, voice instructions, actions, billing and caller eligibility unchanged. No migration or voice-worker deployment is needed.

## Result

- A fresh, account-authorized transcript endpoint reads the existing timestamped fragments for the selected business and call. It retrieves beyond the default 1,000-row response cap, using bounded keyset pages and an explicit partial-result flag above 5,000 fragments.
- Display grouping sorts by speech timing and joins literal provider deltas. Speaker changes and pauses split turns; overlapping speech is marked. There is no generated summary, rewritten wording, deduplicated repetition, or change to action-confirmation boundaries. Raw fragments and their legacy message mirrors remain intact.
- Voice conversations use distinct Caller/AI bubbles, transcript offsets, protected call review, read-only controls, and loading/empty/error/refresh states. Active transcripts refresh every ten seconds while selected. Switching calls cancels stale reads; failed reads do not hide recordings or call outcomes.
- Voice list previews say “View call transcript” instead of displaying the last word fragment.
- Messages Sent counts outgoing assistant/human-agent rows in SMS and website chat during the last seven days. Incoming messages, system notices and voice fragments are excluded. This is a display metric correction; provider usage and SMS/voice allowances are unchanged.

## Verification

- Application regression: **408 files / 6,960 tests passed**. The unchanged voice-worker localhost capacity test was excluded from this UI-only run.
- New/affected focused checks: **88 tests passed independently**, covering grouping, exact punctuation/subwords/repetitions, overlap, 1,201-fragment histories, a provider cap below the requested page size, 5,000/5,001 limits, isolation, removed access, errors, UI, counter filters and previews. The final two UI files were retested after copy and timestamp cleanup: **8 passed**.
- Application and worker TypeScript checks, focused ESLint, diff checks and the production application build passed.
- Read-only verification of an existing production call found **249 fragments → 27 turns**, preserving **all 1,464 characters**. No transcript or caller details were printed or sent to a model; no records were changed.
- Local browser walkthrough used a separate synthetic business in the guarded database at `127.0.0.1:55321`. Fourteen fragments rendered as three exact turns. Desktop and 390px mobile layouts had no horizontal overflow or framework/browser errors, and voice had no reply composer.
- Browser-tested transcript failure and empty responses with temporary local-only fetch mocks; call review remained available and Refresh recovered the three real local API turns. Mocks and the browser session were removed afterward.
- Local dashboard showed **4 outgoing messages**, excluding seeded incoming/system/voice entries. Source and tests preserve normal SMS/web-chat rendering and recording access.

## Deployment

- Private source commit: `e45f08b3d973883d0bffcfe45245e72cbb723632`; canonical tar SHA-256 `f0e476633e46b461a81918fe0ac3e3d756978748a2d8e5ed7c771dde08dbeca6`. Independent review verified all 1,200 uploaded files match the commit, without missing or extra files. No public Git push.
- Application deployment: `591fc262-ab34-4cd4-a001-dd8ce6ba1cfb`, **SUCCESS**. Independent verification at 16:35:36 UTC on September 17 confirmed application and worker health HTTP 200 and unauthorized access to the new transcript endpoint HTTP 401, without redirects.
- Voice deployment `99a21106-e7ef-433e-ac27-5f63fd9a082b` and scanner `12c2582a-2263-4055-92a8-1f4eaf27c642` remain unchanged. No production database records, call settings or billing settings were mutated by this release.

Existing call transcripts gain the display fix without a backfill or another phone call.

Rollback is to restore the previous application deployment. No data restoration, message replay, billing adjustment or transcript rewrite is required.
