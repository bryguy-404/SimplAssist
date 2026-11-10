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

## Release and caller acceptance

Deploy only the web app from a clean committed-source archive. The voice worker,
environment variables, service settings and database remain unchanged. Verify
the new deployment, public app health, unsigned-webhook rejection, protected
settings endpoints, and unchanged worker readiness after release.

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
