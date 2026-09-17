# Full Suite public launch — implementation and verification

Approved scope: [implementation plan](full-suite-public-launch-plan.md). Baseline `9aed12a`, branch `codex/full-suite-launch`.

## Current status

Migrations 084–086 and the closed app/worker deployments are applied and independently verified. The first live public-opening rehearsal exposed a protocol error at the handoff into conversation; the worker correction is now deployed and independently verified, awaiting repeat phone acceptance. Full Suite sales and public voice admission remain closed. No subscription change or launch email has been performed. The prepared sales-opening change must not be deployed until the public opening and recording acceptance below passes.

## Phase 1 — package and capability catalog

- Full Suite presents $65, 2,500 SMS parts, 100 voice minutes, existing Growth features and custom AI guardrails. Homepage/comparison, preview-home content and waitlist/email templates share the agreed package. Long-message parts and voice limit behavior are explained.
- Reserved future capabilities grant no access and no longer produce an upgrade recommendation. Their identifiers remain available for future implementation.
- Homepage pricing FAQ responds to the existing sales gate; changing that gate later will not leave a stale “cannot be purchased” claim.
- Relevant catalog, entitlement, onboarding, homepage and mocked-email checks: **10 files / 209 tests passed**. This is not a production or browser verification.

## Pending release evidence

Public greeting and protected playback acceptance; final sales activation and independent readback. The earlier implementation, automated, browser, sensitive-change and closed-deployment checks below have passed.

Do not mark the release complete until the required evidence is recorded. Friend's first actual booking/invitation is the agreed post-launch live verification.

## Final local verification

- Application suite: **404 files / 6,888 tests passed**, including the four-call HTTP/WebSocket harness. Its sandbox socket-denial retry passed with localhost permissions; providers remain mocked.
- Database suite: **75 files / 3,296 assertions passed** after a fresh guarded replay. Final migration bytes match the disposable database's copies.
- Application TypeScript, voice-worker TypeScript, focused lint, and both closed-version and final prepared sales-open production builds passed.
- Independent billing/deletion review completed two rounds: cancellation authority survives cleanup until terminal proof; setup-fee proof is retained; late callbacks for fully scrubbed tombstones do not recreate billing work. No remaining findings in reviewed scope.
- Desktop/mobile browser walkthrough verified the prepared $65/2,500-SMS-parts/100-minute pricing, ordinary signup link, default Text selection, saving Voice mode with confirmation, usage/readiness and no horizontal overflow. No browser errors or framework error overlay. New paid accounts now display 0/2,500 before any message; expired prior-period usage is excluded. Actual Stripe transactions were not performed.
- New public disclosure and four-session capacity are exercised with mocked providers; this is not real-phone acceptance or a measurement of hosted fleet load.

## Production migration and release preparation

- Guarded atomic 084–086 application succeeded; a separate read-only session verified exact canonical migration text and the tested function, table, constraint, trigger, RLS and grant catalog. See [schema evidence](full-suite-public-schema-review.md).
- Existing pilot, tester, subscription, call history, usage and Leads fingerprints remained unchanged. The two seeded billing identity records match existing subscriptions. No commercial grant, retirement, purchase or rehearsal was fabricated.
- Closed release source: `fcea00e7e33671630bb474f35e50c651fc679af2`; private tar SHA-256 `75bc9cdd19457a1239857009629f7e8671ffcc2c4240e491f388530c5c941933`. App and worker archives contain no local environments, dependencies or build artifacts; the worker excludes both app/scan Railway config files.
- App source was disconnected from the older public GitHub `bryguy-404/SimplAssist` `main` trigger to prevent an unrelated push overwriting the private release. Voice had no connected source. Scan remains connected and unchanged. To reconnect the app later, use the recorded app project/service selectors with `railway service source connect --repo bryguy-404/SimplAssist --branch main`, only after main contains the intended release; then verify trigger settings.
- Rollback baselines: app `34e7aae2-84e4-4ffb-931f-45d6c83e922c`, voice `ff5d7285-f638-49ef-9ca7-83581be113e7`, unchanged scan `12c2582a-2263-4055-92a8-1f4eaf27c642`. Retain additive schema, paid records and history. Close new admissions/sales before a rollback; never revive a retired pilot exception.
- Closed app deployment `2651c426-dbb9-4226-95d9-b759507b321e` and voice deployment `0aca703b-b3fb-4e59-af66-869956c3a048` are SUCCESS. Independent verification confirms exact active IDs, healthy app/worker, authenticated readiness 200, commercial protocol 2/action protocol 1, GPT-Live-1/pcm16, zero active calls, and unchanged scan. Unauthenticated worker readiness remains 404; owner voice/billing routes return 401. Database baseline fingerprints remained unchanged after deployment.
- Live homepage independently read back: Full Suite remains closed, with 100 voice minutes and 2,500 SMS parts displayed.
- Prepared opening commit `34fcea1134ee6b3084c1100b79db01035376c1e7` is tested and committed but **not deployed**. Its private tar SHA-256 is `e9802d4c931632fea182f552202e7250637ef460bb25ef1c2941be6c9d233428`; app artifact `/private/tmp/simplassist-full-suite-open-34fcea1-app`. The guard-protected final database activation script is `/private/tmp/simplassist-full-suite-activate-after-acceptance.sql`; it is **not executed** and does not replace user acceptance or live protocol verification.

## Required final phone acceptance

After both closed deployments and readiness checks pass, arm the existing approved caller's single-use public-opening rehearsal. It expires after 30 minutes and changes neither the subscription nor the 200-minute pilot accounting. Check the same-Marin AI/recording notice, continuation into the normal signup conversation, exactly one requested signup text/Lead, and protected recording playback. Inspect stored notice/playback/recording/handoff timestamps. Only after acceptance may the prepared sales-open app and global commercial eligibility/capacity-four setting be activated and independently verified.

The one-call rehearsal was armed on September 17 at approximately 14:07 UTC for the existing approved caller only. Bryan chose to test immediately, and call `04336c36-a744-4d89-bf8e-62d3a7789a98` consumed it. Independent verification confirmed exactly one arm audit, no other caller permission change, and unchanged earlier call records.

**First public rehearsal failed; do not open sales.** The notice completed at 14:09:13.947 UTC; recording started at 14:09:14.182; the handoff started at 14:09:14.246. The call closed with `openai_protocol_error` at 14:09:15.684. No contact/signup action ran, no Lead was created, one recording was retained, and the eligible technical-failure fallback completed. Historical error handling did not retain provider error details, so the exact provider rejection code is unavailable.

Code inspection found the handoff appended the entire voice guide (1,030 words / 6,573 UTF-8 bytes) through an API limited to 500 tokens per append. [OpenAI's session guidance](https://developers.openai.com/api/docs/guides/live-conversations#add-context-during-the-conversation) permits the larger guide at startup. Move the normal guide to startup with an explicit pre-notice gate; use a short acknowledged activation delta after verified notice/recording. Add bounded error-code diagnostics without caller content. Retest and privately deploy the worker correction before re-arming. The older prepared sales-open artifact must be superseded with the corrected source before final activation.

### Handoff correction

- `920aaf3e6b1adb81d02892424aaf468f45b194e1` moves the full accepted guide into session startup behind the public-opening guard. The handoff now sends a fixed 243-byte activation update and waits for its matching acknowledgment before the conversation nudge. Wrong/duplicate acknowledgments are ignored; a missing acknowledgment has an eight-second bound. Normal private-pilot tone, actions and guidance remain unchanged.
- Safe diagnostics retain bounded provider code/type/parameter and client command identity, never the raw provider message, instructions or caller content.
- A direct, bounded OpenAI protocol check used only synthetic text and silent audio, with storage disabled and no phone/SMS/business data. The oversized append was rejected with `invalid_value`, parameter `content`, and the documented 500-token limit; a short append was acknowledged. Final reported usage was zero seconds. This reproduces the protocol defect without claiming a recovered historical provider code.
- **404 files / 6,893 tests passed** after the correction, including both codecs, acknowledgment ordering/timeouts, privacy diagnostics, and the real local four-socket harness. Application/worker types, focused lint and production build passed. No database change was needed.
- Corrected private archive SHA-256: `7ad0ef4e567bba0fd1a4e3243c4a9e8736022a72f9ee8e215ab950a817b4ca02`. Worker deployment `d8ba4898-c6d0-4038-8a6f-962286b3f00e` is SUCCESS and independently verified as the sole active worker, healthy and ready on protocol 2 with zero calls at verification. App remains on closed source `fcea00e`/deployment `2651c426-dbb9-4226-95d9-b759507b321e`; scanner unchanged.
- Final opening must use the corrected app archive `/private/tmp/simplassist-full-suite-handoff-920aaf3-app` after live acceptance, not the superseded `34fcea1` archive. The unexecuted activation SQL now excludes failed/fallback rehearsals and requires the signup/Lead evidence, in addition to human greeting and protected-playback acceptance.
- The same approved caller's single-use public rehearsal was rearmed after verification; it expires **September 17 at 14:54:31 UTC / 10:54:31 AM Eastern**. Bryan was asked to repeat the full signup and protected playback check. No acceptance has been reported for the corrected deployment yet. Public purchases/admissions remain closed, and Bryan's subscription has not changed.

## Verification in progress — September 17

- Current application checkpoint: **403 Vitest files / 6,859 tests passed**, application TypeScript passed. Later edits must receive their relevant verification before the final build.
- Booking checkpoint: **5 files / 168 tests passed**. Confirmed call details must match the action, including the email used for invitations; provider submission rechecks current authority. A proven pre-submission stop is distinguished from an uncertain Google result. Independent review found and fixed an omitted-confirmation-linkage bypass; read-only availability remains allowed.
- Actual local worker HTTP/WebSocket harness: four concurrent public-opening sessions, 100 paced audio frames each way per session, isolated delegated answers, a rejected fifth connection without consuming its credential, then successful admission after a slot opens. External providers/storage are mocked; this is not a real-phone or hosted-capacity measurement.
- Read-only production check: Full price active, USD 6,500 cents/month, monthly interval 1; existing portal subscription updates remain disabled. No price or subscription mutation.
- Aggregate pilot cost checkpoint:14 calls, 1,948 OpenAI seconds; recorded estimates $1.62333 OpenAI + $0.42618 Anthropic + $0.38011 Telnyx, about **$7.48 per 100 provider minutes**. Two Anthropic rows have unknown cost; Telnyx estimates are unconfirmed. SMS, hosting, numbers/registration, payment fees, taxes and provider adjustments are excluded. No unresolved phone legs found. This does not establish complete unit margins or customer-minute cost for the new free opening.
- Bryan explicitly waived additional real Stripe test-mode transactions because he already purchased through the existing payment integration. Automated mocked/local billing checks remain required. New provider proration/rejoin/payment-failure lifecycle is not independently exercised against Stripe in this batch. No missing-test-key blocker remains.
- Reference cross-check: the required upgrade fields are supported by [Stripe pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates#supported-attributes-for-pending-updates); this documentation check is not a provider transaction test.
- Read-only compatibility inventory: all three recurring SMS plan prices are active, USD, monthly licensed prices ($25/$45/$65), and setup is an active $25 one-time price. Zero open legacy SMS, legacy rejoin, or durable SMS Checkout sessions were found. Recheck immediately before migration because an older open rejoin Checkout must not be stranded by the new source guard.
