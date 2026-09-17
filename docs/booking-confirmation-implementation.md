# Booking and confirmation implementation

Approved scope: shared business booking formats and service overrides; revisioned confirmation across voice, SMS and website chat; optional voice review text and offered final confirmation text; accurate calendar/request reporting. Email is optional. Existing signup behavior, billing, voice style and retired pilot remain unchanged.

Baseline: 59484b1. Branch: codex/booking-confirmations.

## Phases
1. Booking settings, server-resolved offerings, immutable appointment snapshots and durable storage.
2. Shared preparation and confirmation lifecycle, latest-revision authorization, full-duration availability and existing calendar reconciliation.
3. Permission-bound voice notifications, transport acknowledgments and dashboard results.
4. Automated/local database/browser verification, compatible private Railway deployment and real booking acceptance.

Each phase has a separate commit and relevant checks. A schema or implementation foundation is not a completed live feature. No booking account is converted from signup. Real booking acceptance requires an approved booking account; automated provider tests remain mocked.

## Acceptance
Check corrections and optional email, unavailable/full-duration slots, duplicate confirmations, provider uncertainty, opt-out and usage checks, account isolation and cleanup. One confirmed booking produces one calendar event; notifications do not create duplicate messages or charges. Calendar invitation requests and actual email delivery remain distinct. Collect-info mode creates a request, never a confirmed appointment.

## Progress
- Implementation started; no production changes applied.

### Phase 1 work in progress
Added protected settings and server-resolved offerings, onboarding format selection, service overrides, and revision/notification schema with owner isolation and cleanup. Targeted settings/onboarding/contracts tests: 79 passed. Initial local schema/isolation assertions: 13 passed. Type check and lint passed. Remaining foundation review includes draft scope tests and final local migration replay. No production migration or deployment yet.

Phase 1 database replay: all 88 migrations applied in the guarded local SimplAssistVoice environment; 77 database test files / 3,382 assertions passed. The root local database and production were not targeted. Settings route/service, contracts and onboarding focused checks passed; lint and app type check passed. Browser verification remains in phase 4.
