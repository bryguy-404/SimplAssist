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

### Phase 2 work in progress
Added draft preparation/acknowledgment/claim RPCs; wired preparation and confirmation into SMS/chat and voice behind `BOOKING_CONFIRMATION_V2_ENABLED` (default off), with a separate default-off database control. Full-duration availability now supports server-resolved service settings and local pending reservations. Calendar writes can validate the current confirmed draft at entry and immediately before submission. Draft reconciliation only reads existing booking/request results and never repeats provider writes.

New confirmation ordering/correction/deletion assertions: 13 passed after fixing conversation status and SQL alias issues. Existing selected calendar/voice/tool/prompt regressions: 231 passed. New draft/duration plus settings unit checks: 45 passed. Full phase 2 integration verification remains outstanding; neither runtime control has been enabled and no production changes have been made.

Phase 2 review: preserved migration 085's existing commercial booking permission rules rather than replacing them. Replayed through migration 089: 78 SQL files / 3,395 assertions passed. Focused engine, draft, availability and voice tests: 228 passed, including preview refusal and replacement of the legacy mutation tool. Additional existing webhook/internal action checks passed. New flow remains disabled pending notification integration and full release verification.

### Phase 3
Implemented permission-bound optional review and offered final voice texts, durable provider acceptance/message/usage bookkeeping, separate delivery outcomes, SMS read-back send claims, and recovery of committed web-chat summaries. Voice review replies are directed back to the active call; texting permission cannot execute the booking. Added business-scoped appointment review for all conversation channels and calendar location display. Worker readiness includes booking protocol compatibility. Feature controls remain off in production.

Verification: full application suite 7,022 tests passed; its local socket capacity test separately passed with local socket permission (7,023 total at that checkpoint). Isolated migration replay through 090: 79 files / 3,418 SQL assertions passed. Further focused notification/voice tests include concurrent sends, unknown acceptance, separate text consent and no repeated contact saving. Desktop/mobile browser checks used synthetic local data: settings saved/reloaded, request details accurately labeled, no horizontal overflow or browser errors. No real messages, invitations, or production changes occurred.

### Phase 4 local release verification
Full regression: 417 files / 7,034 tests passed; three further notification-recovery assertions passed. Final isolated database replay: 79 files / 3,419 assertions passed. App/worker TypeScript, lint, production build and desktop/mobile walkthrough passed. Release hardening preserves existing signup/contact fingerprints and recovers notification action bookkeeping independently of delivery. Production baseline 087 and retired pilot were checked read-only. The SQL bundle and release runbook are prepared; production application/deployment is awaiting the requested workflow confirmation. Real booking acceptance still requires the approved real booking account.
