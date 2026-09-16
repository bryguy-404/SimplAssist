# Voice Stage 2 implementation

Approved September 15, 2026. Build contacts, direct bookings, owner-reviewed appointment requests, and permission-based signup SMS on the private voice pilot. Preserve current tone and Q&A fallback.

## Decisions

- Same approved caller and existing number; current release uses the real SimplAssist signup flow. Freeze route at admission.
- Booking requires name and phone; email optional for invitations. Signup SMS only to calling number after permission.
- Future booking demo would use a separate business and dedicated test calendar; it is not provisioned or enabled in this release.
- Durable proposals, playback/read-back evidence, explicit confirmation, idempotent execution and uncertain-result reconciliation precede success claims.
- Capabilities default off. Keep 200-minute budget, two concurrent calls, ten-minute cap, recording/disclosure controls.
- Separately prepare provider connection during ringing; retain bounded ringing fallback.
- Separate commits per phase: foundation, actions, demo/review, preparation, deployment/verification.

## Release gates

Local database tests and application/worker checks; prepared migration applied by Bryan then schema verified; signup URL and SMS readiness validated; at least 20 real calls and owner voice approval. Do not mark phone acceptance complete from mocked checks. Calendar acceptance is deferred to its own release gate. Top-tier billing remains Stage 3.

## Scope update during implementation

Bryan chose to test the existing SimplAssist signup/Get Started flow first, with no new demo login or Telnyx onboarding. Keep booking and demo routing disabled. Calendar live acceptance and demo provisioning are deferred. The account currently has goal `book` and no signup URL; prepare the explicit goal change to `signup` with the verified existing `/signup` destination as part of activation.
