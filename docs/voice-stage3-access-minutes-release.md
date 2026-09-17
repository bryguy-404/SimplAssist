# Full Suite voice access and monthly minutes

## Scope

Approved September 17, 2026: prepare Full Suite at $65/month with 100 voice minutes per subscription billing month. Preserve its existing SMS allowance. Purchases stay `coming_soon`; commercial voice starts disabled with an empty allowed-business list. No paid voice overage, homepage launch, booking activation, or change to the private pilot's approved conversation style is included.

Implementation starts at `9540d3c` on `codex/voice-access-minutes` in the existing dashboard worktree. The unrelated root checkout and original pilot worktree are preserved. Deployments use private committed-source archives; no public GitHub push is authorized.

## Reviewable phases

1. Access foundation: Full-only feature matrix, default-off rollout, protected preferences, separate customer accounting and immutable call grants.
2. Allowance and billing: authoritative versioned Stripe reconciliation; canonical subscription binding; one grant per billing period; concurrent reservations, independently evidenced customer time, and customer-favorable recovery of unproven time.
3. Routing and worker: choose voice only after unanswered forwarding/ringing; preserve pilot behavior; use the admitted reservation through ordinary preference or billing changes; stop on emergency, suspension, deletion or deadline; preserve one eligible fallback.
4. Owner controls: fresh owner authorization, revision-checked settings, monthly/pilot usage, business-timezone reset dates, held-minute warnings and safe stale-state refresh.
5. Verification and closed deployment: application/database tests, independent billing/deletion review, desktop/mobile walkthrough, production schema verification and private application/worker deployment.

## Meter and recovery

Customer time starts at the first audible frame forwarded to the phone, validated by its unique playback acknowledgment. It includes conversation pauses and backend waits until verified phone termination. Provider session duration remains a separate cost meter. A call reserves up to 600 seconds and requires at least 60 available seconds. Customer time is capped by that reservation; no voice charge is created.

Incomplete evidence stays held after the call ends. Durable recovery waits up to 24 hours, then waives unproven customer time and records an adjustment. Stream closure and an accepted hangup command are not proof the phone ended. Verified termination without an original timestamp stops repeated provider cleanup but does not invent a customer end time. Settled usage and call deduplication survive deletion of conversation history. Unsettled history waits for settlement; account suspension/PII cleanup still follows the existing cleanup workflow.

Ordinary preference changes, period rollover and entitlement expiry stop new admissions without cutting an admitted call. Emergency controls and account suspension revoke continuation. Requested signup texts retain their independent SMS checks and accounting.

## Validation record

- Full application suite: 398 files, **6,780 tests passed**.
- Application production build, including lint and route/type checks, passed. Worker TypeScript and focused ESLint passed.
- Final complete isolated database verification: 71 files, **3,095 assertions passed**; the 81-assertion targeted suite also passed. No provider calls were used for these action tests.
- Independent billing/access review and two-round deletion review resolved source-binding, proration, missing-period and lock-order findings. See [UI and independent review](voice-stage3-access-minutes-ui-review.md).
- Read-only live Stripe configuration inspection found an active USD 6,500-cent monthly Full Suite price and an active portal with subscription updates disabled. No Stripe configuration, subscription, invoice or charge was changed.

### Browser walkthrough

Verified the real local Next.js pages against isolated Supabase on port 55322, using synthetic owner/business records and a local fake worker-readiness endpoint. No production identity or external AI/phone call was used.

- Desktop and 390px mobile settings and billing usage render without horizontal overflow or browser page errors.
- Saving Text → Voice persisted through the owner API and database, incrementing revision 1 → 2; a second-tab edit reached revision 3.
- Submitting an older draft returned a conflict, refreshed once, and preserved revision 3 without replaying the rejected change.
- The 100-minute fixture showed 80 used, 10 held and 10 available, with an approaching-limit notice and the business-timezone reset date. Used and reserved minutes remained distinct.
- The walkthrough found an extra `revision` field carried into the form request. The serializer now explicitly sends only the three supported fields; the strict API remains intact. The successful save was repeated in the browser, and **129 focused UI/page/API/loader tests passed** after this correction.
- Local screenshots: `/tmp/simplassist-voice-access-settings-desktop.png`, `/tmp/simplassist-voice-access-settings-mobile.png`, `/tmp/simplassist-voice-access-billing-mobile.png`, `/tmp/simplassist-voice-access-usage-warning-mobile.png`.

## Deployment status

Migrations 081–083 were applied atomically and independently verified at 06:36 UTC. All canonical hashes and the compared local/production catalog matched. The pilot settings/testers, subscriptions, call/provider/SMS usage and Leads were unchanged. Commercial rollout is disabled and the allowed-business list, commercial preferences, billing projections and customer usage tables remain empty. See [independent production verification](voice-stage3-access-minutes-production-review.md).

These are private source uploads. A later deployment from older `main` code could replace them; preserve this feature source before resuming automated main deployments.

The private source archive is revision `14d96aa`, SHA-256 `dad2cdfdcd2f04426732f304a6059b39d48f04ac8e277b5993f5a8c7fc491177`. It excludes local environments, dependencies and build artifacts; the worker upload also excludes app/scan Railway configuration files. Four implementation commits precede the verification/documentation commit: `552356d`, `46d19e9`, `ad5f132`, `14d96aa`.

- Voice worker deployment `ff5d7285-f638-49ef-9ca7-83581be113e7` succeeded. Health and authenticated readiness return 200, ready=true, GPT-Live-1, pcm16, action protocol 1 and commercial protocol 1, with zero active calls. Unauthorized readiness returns 404. Application/worker internal credentials match without being printed.
- Application deployment `34e7aae2-84e4-4ffb-931f-45d6c83e922c` succeeded from the same private source archive. Application/worker health and authenticated readiness return 200; unauthorized owner review and the new settings endpoint return 401, and unauthorized worker readiness returns 404. The worker reports zero active calls, GPT-Live-1/pcm16 and both protocol versions 1.
- Independent post-deployment verification at 06:44 UTC confirmed both new deployment IDs are successful, the scan worker is unchanged, apex/www and worker health return 200, and the protected settings endpoint returns 401 without authentication. Commercial rollout remains off with an empty allowlist/accounting state; all baseline pilot, subscription, usage and Leads fingerprints remain unchanged.
- The final production build after the browser save correction passed.
- A new caller-driven acceptance test was requested after deployment. Bryan chose to test later. Its spoken experience, one-text/one-Lead outcome and recording playback remain pending; the approved previous calls are not treated as proof of this release.

## Rollback

Disable commercial admissions first. Drain any commercial calls using a compatible worker and continue settlement/recovery before restoring an older application/worker pair. Retain additive schema, usage and history. Do not replay signup actions, resend messages or reset minutes. Private pilot controls remain independent.

## Remaining launch work

Commercial sales and access remain closed until public greeting/recording behavior, additional businesses, actual bookings/calendar invitations, remaining structured call/failure tests, worker capacity and combined costs are verified. A replacement Stripe subscription for an already projected account currently fails closed; an explicitly authorized subscription-replacement flow must be verified before commercial resubscription opens. Homepage/checkout/onboarding rollout and paid extra usage require their later approved release work.

After closed deployment, Bryan should make one approved private signup call and confirm the accepted speech experience, one signup text, one Lead and protected recording playback. Automated checks cannot establish real phone naturalness.
