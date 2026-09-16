# Voice Stage 2 implementation

Approved September 15, 2026. Build contacts, direct bookings, owner-reviewed appointment requests, and permission-based signup SMS on the private voice pilot. Preserve current tone and Q&A fallback.

## Decisions
- Same approved caller and existing number; admin selects real SimplAssist or isolated booking demo. Freeze route at admission.
- Booking requires name and phone; email optional for invitations. Signup SMS only to calling number after permission.
- Demo uses a separate business and dedicated test calendar. Demo SMS disabled; invitation recipients restricted to approved tester email.
- Durable proposals, playback/read-back evidence, explicit confirmation, idempotent execution and uncertain-result reconciliation precede success claims.
- Capabilities default off. Keep 200-minute budget, two concurrent calls, ten-minute cap, recording/disclosure controls.
- Separately prepare provider connection during ringing; retain bounded ringing fallback.
- Separate commits per phase: foundation, actions, demo/review, preparation, deployment/verification.

## Release gates
Local database tests and application/worker checks; prepared migration applied by Bryan then schema verified; dedicated demo calendar connected through normal OAuth; tester email approved; signup URL and SMS readiness validated; at least 20 real calls and owner voice approval. Do not mark phone acceptance complete from mocked checks. Top-tier billing remains Stage 3.
