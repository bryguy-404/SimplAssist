# Full Suite public launch — implementation and verification

Approved scope: [implementation plan](full-suite-public-launch-plan.md). Baseline `9aed12a`, branch `codex/full-suite-launch`.

## Current status

Implementation and local verification are complete. Migrations 084–086 are applied and independently verified. The closed application deployment is in progress; Full Suite sales and public voice admission remain closed. No subscription change or launch email has been performed. The prepared sales-opening change must not be deployed until the public opening and recording acceptance below passes.

## Phase 1 — package and capability catalog

- Full Suite presents $65, 2,500 SMS parts, 100 voice minutes, existing Growth features and custom AI guardrails. Homepage/comparison, preview-home content and waitlist/email templates share the agreed package. Long-message parts and voice limit behavior are explained.
- Reserved future capabilities grant no access and no longer produce an upgrade recommendation. Their identifiers remain available for future implementation.
- Homepage pricing FAQ responds to the existing sales gate; changing that gate later will not leave a stale “cannot be purchased” claim.
- Relevant catalog, entitlement, onboarding, homepage and mocked-email checks: **10 files / 209 tests passed**. This is not a production or browser verification.

## Pending release evidence

Final billing and database checks; commercial eligibility/accounting and retirement; public disclosure; application/worker build checks; independent sensitive-change review; desktop/mobile walkthrough; independently verified production schema/deployments; public greeting and protected playback acceptance; final sales activation.

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

## Required final phone acceptance

After both closed deployments and readiness checks pass, arm the existing approved caller's single-use public-opening rehearsal. It expires after 30 minutes and changes neither the subscription nor the 200-minute pilot accounting. Check the same-Marin AI/recording notice, continuation into the normal signup conversation, exactly one requested signup text/Lead, and protected recording playback. Inspect stored notice/playback/recording/handoff timestamps. Only after acceptance may the prepared sales-open app and global commercial eligibility/capacity-four setting be activated and independently verified.

## Verification in progress — September 17

- Current application checkpoint: **403 Vitest files / 6,859 tests passed**, application TypeScript passed. Later edits must receive their relevant verification before the final build.
- Booking checkpoint: **5 files / 168 tests passed**. Confirmed call details must match the action, including the email used for invitations; provider submission rechecks current authority. A proven pre-submission stop is distinguished from an uncertain Google result. Independent review found and fixed an omitted-confirmation-linkage bypass; read-only availability remains allowed.
- Actual local worker HTTP/WebSocket harness: four concurrent public-opening sessions, 100 paced audio frames each way per session, isolated delegated answers, a rejected fifth connection without consuming its credential, then successful admission after a slot opens. External providers/storage are mocked; this is not a real-phone or hosted-capacity measurement.
- Read-only production check: Full price active, USD 6,500 cents/month, monthly interval 1; existing portal subscription updates remain disabled. No price or subscription mutation.
- Aggregate pilot cost checkpoint:14 calls, 1,948 OpenAI seconds; recorded estimates $1.62333 OpenAI + $0.42618 Anthropic + $0.38011 Telnyx, about **$7.48 per 100 provider minutes**. Two Anthropic rows have unknown cost; Telnyx estimates are unconfirmed. SMS, hosting, numbers/registration, payment fees, taxes and provider adjustments are excluded. No unresolved phone legs found. This does not establish complete unit margins or customer-minute cost for the new free opening.
- Bryan explicitly waived additional real Stripe test-mode transactions because he already purchased through the existing payment integration. Automated mocked/local billing checks remain required. New provider proration/rejoin/payment-failure lifecycle is not independently exercised against Stripe in this batch. No missing-test-key blocker remains.
- Reference cross-check: the required upgrade fields are supported by [Stripe pending updates](https://docs.stripe.com/billing/subscriptions/pending-updates#supported-attributes-for-pending-updates); this documentation check is not a provider transaction test.
- Read-only compatibility inventory: all three recurring SMS plan prices are active, USD, monthly licensed prices ($25/$45/$65), and setup is an active $25 one-time price. Zero open legacy SMS, legacy rejoin, or durable SMS Checkout sessions were found. Recheck immediately before migration because an older open rejoin Checkout must not be stranded by the new source guard.
