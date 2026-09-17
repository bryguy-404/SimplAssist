# Natural greeting database review — 2026-09-17

## Scope

Migration `087_voice_natural_opening.sql` adds a protected, default-on recording-announcement policy and freezes each new public call's opening protocol. Turning the policy off selects version 2 for new commercial calls and explicitly armed public-opening rehearsals. Ordinary pilot handling, existing calls, business eligibility, budgets, provider usage and monthly allowance amounts are unchanged.

Version 2 binds a consumed media credential to one provider session, records the provider recording-start acknowledgment, then activates normal conversation handling. It does not populate notice, prior-disclosure acknowledgment, or announcement-handoff evidence. Constraints prevent later callbacks from inventing that evidence. The version and rehearsal status cannot change after insertion.

`activate_voice_natural_opening(uuid,text,numeric)` is service-only and checks the existing business continuation authority, recording start, provider binding, and input boundary. Its locks follow business → allowance period → customer usage → session. Transcript processing can retain the first caller reply immediately after activation. Customer minutes still start only from the first audible frame and its phone playback acknowledgment. A one-second cross-host clock tolerance matches the established handoff assumption; the original timestamp is retained. Setup-only termination settles zero; uncertain active-call evidence retains the existing recovery hold and waiver policy.

## Verification

- Focused new SQL suite: **73 assertions passed**.
- Clean isolated full database suite: **76 files, 3,369 assertions passed**.
- Guarded harness completed successfully, including local-container identity, migration/catalog checks, and post-suite data-cleanliness verification.
- Disposable project: `SimplAssistVoice`, explicit workdir `/private/tmp/simplassist-voice-db`, ports 55321/55322, pinned Supabase CLI 2.115.0. The original local stack and production were not touched by these tests.
- Tests cover default-on policy and audit, immutable snapshots, old-protocol rejection, consumed credential/provider identity, truthful announcement fields, recording-before-activation, first-reply persistence, cross-host clock tolerance, customer settlement, provider cost estimation without Polly, scoped pilot rehearsal, and actual account privacy cleanup without refunding usage.
- Existing 086 announcement tests, 085 public access/concurrency tests, and billing/deletion regressions pass unchanged. The 082 concurrency fixture now selects its intended legacy protocol before admission instead of rewriting the admitted version.
- Canonical migration MD5: `bd0b4d5529d5bb16fa2c73c43acc8f37`.

The migration does not turn off the announcement in production. Deployment and a separate protected policy update remain release operations. Actual phone playback, recording availability, and naturalness still require runtime/live-call verification.
