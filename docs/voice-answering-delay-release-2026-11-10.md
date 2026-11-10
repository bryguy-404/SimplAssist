# Start customer AI answering without the fixed ringing delay

Bryan approved removing the extra 11-second ringing wait for carrier-forwarded
calls while preserving the other call flows. No new setup choice, database
migration, account mutation, or caller message is part of this release.

## Behavior

When a customer account has AI voice answering selected and SimplAssist's
outgoing owner forwarding is off, the inbound answered callback now attempts
the existing guarded commercial voice admission immediately. It no longer waits
for the 11.2-second voicemail ringing clip to finish first. The existing voice
worker plays connecting audio only until the opening speech is buffered and
the audio handoff succeeds. This removes a fixed delay; it does not guarantee
instant speech or a one-to-two-second connection time.

The rule uses saved account preferences, not optional carrier diversion headers.
It covers forwarded calls even if a carrier omits those headers. Direct calls
to an AI-only SimplAssist number also start AI answering sooner.

The following paths retain their existing behavior:

- SimplAssist ringing the owner's phone first: the 18-second owner dial timeout,
  bridge, answered-call handling, and AI/text fallback remain in place.
- Text-only accounts: existing ringing, voicemail and eligible missed-call SMS.
- Invalid owner-forwarding configurations: existing recovery path.
- Private pilot calls: existing stored-session routing and opening behavior.
- Active calls and callbacks from the previous release: existing lifecycle
  handlers still accept their prior states.

AI admission still checks the existing entitlement, rollout, worker, capacity,
operational and allowance guards. When it persists a denied voice decision, the
chosen voicemail fallback greeting now starts immediately and retains the
frozen text-fallback preference. A routing lookup/admission failure releases
the webhook claim for retry. There is no new SMS sender or booking behavior.

## Local verification

- Confirmed the new immediate-answering expectations fail against the old code.
- 210 focused routing, ringback-asset, and live-session tests passed.
- 1,534 tests across 65 voice, messaging, webhook and phone-settings suites passed.
- Changed-file ESLint passed with no warnings or errors.
- Production Next.js build passed, including TypeScript and 133 static pages.
- Read-only production baseline confirmed healthy app and worker, compatible
  voice protocols and zero active voice calls before release.

## Production release

Deployed the web app on November 10, 2026 from a clean committed-source archive,
without a public repository push:

- Source: `4265b37b80043a50a8fa610b4314a68ecbff6ac5`.
- Archive SHA-256: `f6947df3349f3a17379c819eccd576f1df2ad957a23fb7461d11f18daa5287ec`.
- Railway web deployment: `b43fa4d9-2afd-4725-8ecd-816b96b0c510`, `SUCCESS`.
- Unchanged voice deployment: `95f2d013-404b-47ab-8daa-5d1143b6114f`, `SUCCESS`.

Post-deployment verification confirmed:

- Both public domains returned healthy app responses; signup returned HTTP 200.
- Protected voice and call-forwarding settings rejected unauthenticated requests.
- The voice webhook returned its expected HTTP 403 `Forbidden` response to an
  unsigned empty request, without initiating a call or text.
- The voice worker reported ready, with unchanged action, booking, commercial
  and natural-opening protocols, and zero active calls at verification.
- Environment fingerprints and service settings matched the pre-release
  baseline. No voice-worker release or database migration was performed.

The initial public checks using Python's default user agent received HTTP 403.
Repeating them with an identified browser-style verification user agent passed
all expected app responses; no application or edge settings were changed.

## Caller acceptance

Actual handset timing remains unverified. Once the test account's number is
active, use a customer Full Suite account with AI voice enabled and outgoing
owner forwarding off. First verify a direct call, then configure carrier
forward-when-unanswered and measure the whole call through the greeting. Check
that the original caller is retained, the greeting is complete, conversation
and transcript work, and a normal AI call does not cause a competing generic
missed-call text. Check iPhone Live Voicemail if it intercepts calls. Do not use
the unchanged private pilot flow as evidence of this customer routing change.

The owner-first and text-only paths should also receive a controlled phone test
before making timing guarantees. No external call or text was initiated by the
automated verification.
