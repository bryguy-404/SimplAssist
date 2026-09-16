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

The goal-change SQL was executed against the isolated local fixture and rolled back; it produced Signup + the intended URL. The schema bundle consists of the tested canonical migration bodies inside one transaction. Production migration application, read-only schema verification, private deployments, capability activation and real calls are still pending. The currently deployed Q&A pilot has not been changed by this implementation.
