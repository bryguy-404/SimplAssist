# Natural AI greeting — implementation and release

## Approved change

Bryan approved implementation after discussing this example: “Hi, thank you for calling! I'm SimplAssist's AI assistant. How can I help you today?” The assistant should use the actual business name, identify itself as AI naturally, and offer help once. The example guides small wording variations; it is not a required verbatim script. Preserve the accepted Marin voice, tone, speed, facts, signup and booking actions.

The preceding explicit instruction is to omit the spoken recording sentence for now, retain recordings, and preserve the ability to turn that announcement back on. This is a product configuration decision, not a finding that every caller is in Indiana or that omitting an announcement supplies consent.

Baseline `9b5600e`; branch `codex/voice-natural-greeting`. Preserve unrelated worktrees and use private committed-source Railway uploads only.

## Implementation

1. Add a protected, default-on recording-announcement setting. Snapshot it for new public calls through a versioned opening mode; retain the existing announced-call path and all historical records. A call without the announcement must not receive a completed-notice timestamp or fabricated prior acknowledgment.
2. For the natural opening, prepare recording and the live conversation before the assistant asks its first question. This preserves immediate caller replies and avoids a second help question. Keep startup bounded, enforce business/call authority, and keep preparation outside customer voice minutes.
3. Guide the natural greeting with the approved example and small variations. Keep AI identification, business name and a single offer of help. Preserve interruption handling and the existing action workflow. Retain recording recovery, expiry and correct provider accounting for the new mode.
4. Update recording-review wording and the public privacy description to describe the actual behavior. Test both opening modes, recording failure, early caller replies, fallback, usage and existing signup/booking regressions.
5. Verify the additive migration locally, apply it with the announcement still enabled, independently read back the schema, privately deploy app and worker, verify readiness, and only then switch new calls to the natural opening. Verify the final setting independently. No subscriptions, messages or existing call history are changed by this release.

## Reversal

Turn the protected recording announcement setting back on for subsequent calls. Keep in-flight calls on their admitted opening mode and retain their records. Before rolling back to code that predates the natural mode, restore announcements and drain active natural-mode calls. Never rewrite historical notice evidence.

## Evidence

- Full application regression run: 6,910 tests passed; the sole local-socket capacity test could not bind within the sandbox and passed separately with local-socket permission (6,911 total tests across 404 files).
- Focused runtime checks passed, including early replies, prepared sessions, recording/activation persistence failures, restoration of the announced path and recording recovery. Independent reviewer reran 133 focused tests successfully.
- Clean isolated database replay and suite: 76 files, 3,369 assertions passed. [Schema review](voice-natural-greeting-schema-review.md) records RPC authority, history, cleanup and clock-skew checks.
- Application/worker TypeScript, focused ESLint, diff checks and production application build passed.
- Guarded migration wrapper independently reviewed; canonical migration 087 MD5: `bd0b4d5529d5bb16fa2c73c43acc8f37`.

## Deployment — September 17, 2026

- Source commit: `fe8b8860d39683664ccd35e78a73649c19688ce6`. Private source tar SHA-256: `0063642f9f78cfe24929f3b249f3849cbc8d53d088a08ca1db2a838a0dd73886`. Independent comparison found all 1,190 application files and 1,188 worker files match the commit; the worker excludes only the two app/scan Railway configs. No public Git push.
- Migration 087 applied with the announcement still enabled. A separate read-only verification confirmed the canonical migration and all 12 affected function hashes/security settings, constraints, triggers and policy permissions match the tested local database. All 16 existing call histories and saved pilot/billing baselines were unchanged.
- Application deployment `ddceb449-7939-4ebe-a69a-e76f8b21ba21` and voice-worker deployment `99a21106-e7ef-433e-ac27-5f63fd9a082b` are SUCCESS. Scanner `12c2582a-2263-4055-92a8-1f4eaf27c642` is unchanged.
- After deployment, app/worker health and authenticated readiness returned 200; ready=true, natural-opening protocol 1, commercial protocol 2, action protocol 1, GPT-Live-1/pcm16 and zero active calls. Protected anonymous requests remained denied.
- Applied the guarded policy change only after those checks: `recording_announcement_enabled=false`, revision 3, rollout enabled, emergency stop false, capacity 4. Recording and transcript retention remain unchanged. Existing calls retain their original opening evidence.
- Browser verification confirmed the deployed Privacy explanation and Terms usage wording render correctly; the Terms page has no horizontal overflow. The temporary browser session was closed.
- Final independent verification at 15:18:41 UTC confirmed the disabled-announcement setting, exact successful deployments, readiness and authorization checks, zero active calls, and unchanged historical call, pilot, subscription, allowance and billing records. Bryan remained on the active Growth subscription.

A real caller test after deployment remains necessary to assess the spoken greeting and immediate reply. Ordinary approved pilot calls use the new greeting guidance; verifying the new commercial startup protocol on a phone requires a commercial call or an explicitly armed public-opening rehearsal. No external model test, phone call, SMS, purchase, subscription change or new rehearsal was initiated by this release.
