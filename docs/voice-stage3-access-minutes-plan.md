# Stage 3: Full Suite voice access and monthly minutes

Approved for implementation — September 17, 2026. Bryan approved this plan and its $65/month, 100-minute starting package. Customer rollout and purchases remain closed.

## Plain-English outcome

Prepare voice as a Full Suite feature, give each eligible business its own monthly minute allowance, and let the owner choose voice answering or text follow-up. Keep Full Suite closed to purchases and keep customer voice rollout disabled until the later release checks pass. The existing private SimplAssist test continues to work.

This batch prepares access, settings, and cost controls. It does not open sales, change the approved voice personality, enable booking on the signup pilot, or authorize paid voice overages.

## Baseline and scope

- Start implementation from reviewed revision `9540d3c` on a new `codex/voice-access-minutes` branch, preserving this plan and unrelated work. Recheck the production/source baseline before editing.
- Use five phases, each with one reviewable commit and relevant checks. A phase can depend on earlier phases; it need not be deployed separately.
- Preserve GPT-Live-1/Marin, current answering model, shared knowledge, action confirmations, signup flow, audio transport, and the accepted tone/speed.
- Preserve the designated private pilot's approved callers, current subscription, 200 lifetime minutes, two-call limit, ten-minute call limit, and prior-disclosure handling. Do not reset or convert its historic usage into a paid allowance.
- Full Suite remains `coming_soon`. Growth/$45 keeps its current text and web-chat capabilities.
- Owner access to past conversations, Leads, contacts, and retained recordings continues under existing account-access rules after voice is switched off or a plan changes.

## Approved starting package

**Bryan approved $65/month Full Suite with 100 included voice minutes per billing month on September 17, 2026.** Preserve the existing included SMS allowance. This approval settles the starting package; it does not open purchases or establish profitability. Verify combined operating costs before launching it.

Approved product rules:

| Item | Approved rule |
| --- | --- |
| Reset | Subscription billing cycle, not the first of every calendar month |
| Rollover | None; each cycle receives its own allowance |
| Extra voice usage | Disabled; no automatic purchases or charges |
| Owner warnings | Dashboard notices at 80%, 95%, and exhausted; distinguish used minutes from minutes temporarily held for active calls |
| Primary response | Text follow-up or AI voice answering; voice requires all server-side access checks |
| Optional fallback | Eligible text follow-up if voice cannot start or fails; display that ordinary SMS allowance/rates still apply |
| Exhaustion | No new voice call when no usable capacity remains; use the selected eligible fallback or the existing voicemail path without a generic text |
| Short remaining balance | Require at least 60 seconds available to start; reserve up to ten minutes and warn 30 seconds before the reserved conversation time expires |
| Concurrent calls | Initially two per business, plus a separate worker-wide capacity limit established by load testing |
| Existing call when owner switches mode | Finish within its existing reservation; new calls use the new preference |
| Downgrade/cancellation | Stop new voice at the effective loss of entitlement; let an already admitted call finish within its reservation |
| Suspension/emergency stop | Stop admissions and safely close active sessions; preserve records |

No email/SMS usage-alert campaign is part of this batch. Dashboard warnings and operational/admin visibility are sufficient for the first release candidate.

### Cost evidence and limits

Read-only pilot aggregate captured September 17, 2026 at 05:44 UTC:

| Cohort | Confirmed provider voice minutes | Known estimated voice-related cost | Estimated cost/minute |
| --- | ---: | ---: | ---: |
| All 13 retained pilot calls | 28.60 | $2.15430 | $0.07533 |
| Four calls with delivered signup texts | 11.3667 | $0.83102 | $0.07311 |
| Latest completed signup call | 2.4833 | $0.18210 | $0.07333 |

These are application estimates, not reconciled provider invoices. Two answering-model requests in one older call have unknown cost. Phone costs are estimates; all 13 GPT-Live duration records are confirmed. The sample comes from one business and is small. SMS, number rental, hosting/database allocation, payment processing, taxes, support, and other Full Suite features are not included. Customer conversation minutes will also differ slightly from provider session minutes.

At the observed known-cost range, 100 provider voice minutes extrapolate to roughly $7.31–$7.53, and 200 to $14.62–$15.07, before those exclusions. Reconcile invoices and model the existing SMS allowance and other costs before authorizing sales. Do not use these figures to promise margins or unlimited usage.

Current reference rates were checked against [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [OpenAI voice cost accounting](https://developers.openai.com/api/docs/guides/voice-latency-cost), [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), and [Telnyx Voice API pricing](https://telnyx.com/pricing/voice-api). GPT-Live is $0.05/minute; the backend is separate. The current implementation estimates uncached Haiku 4.5 at $1/$5 per million input/output tokens and Telnyx from published starting rates. Account invoices remain the final cost evidence.

## Important findings from the code review

1. `planAvailability.ts` blocks direct Full Suite checkout and marks customer-facing cards coming soon. Stripe customer-portal configuration and administrator billing paths are separate controls. The repository's portal readiness checks require subscription updates disabled; the actual external configuration was not inspected for this plan. Opening sales is a coordinated release change, not simply exposing a button.
2. Existing entitlement resolution can treat legacy billing overrides as Full Suite. That must not automatically grant paid voice. Commercial voice needs explicit entitlement, a valid allowance period, operational readiness, and rollout approval.
3. Pilot admission, stream activation, heartbeat, actions, and maintenance contain pilot-specific assumptions. A new customer settings page alone would not make another business's calls work safely.
4. `voice_sessions.used_seconds` currently measures provider session time. It must remain available for cost reconciliation and the private pilot. Customer allowance time requires a separately defined meter.
5. Current phone-end persistence can overwrite timestamps during retries. Commercial settlement needs immutable evidence and idempotent corrections before these timestamps can determine customer usage.
6. The current public notice is explicitly a test notice. Private prior-disclosure acknowledgments must not become a general customer bypass. Public greeting/recording approval remains a release prerequisite.

## Phase 1 — Access policy and durable account configuration

Add `ai_voice_answering` to the explicit feature matrix for Full Suite only. Define one authoritative voice policy with explicit admission and continuation decisions, and matching database guards used by settings updates, call admission, stream consumption/start, action execution, and operational rechecks.

Require all of the following to admit a new commercial voice call:

- Correct business and assigned called number, with an operationally active account.
- Full Suite entitlement from synchronized billing and a valid current allowance period.
- A default-off global customer voice rollout switch and a server-owned allowed-business list. Owners cannot edit either; these are separate from whether a plan can be purchased.
- Owner voice preference enabled, supported account configuration, ready worker, and available allowance/capacity.

The designated tester pilot remains a separate, narrowly scoped access source. Ordinary billing-pilot/comped flags cannot create a new voice exception. Invoiced or complimentary commercial accounts require an explicit grant with an allowance and billing-period policy; defer them unless deliberately included in approval.

After admission, the immutable call grant and unexpired reservation authorize bounded continuation, including stream startup and approved contact capture. Ordinary owner preference changes, billing-period rollover, or plan expiry do not abruptly cancel that grant. Deletion, suspension, explicit emergency stop, invalid call identity, or deadline expiry revoke it. Signup SMS retains its own current messaging entitlement, opt-out, operational and usage checks; if those fail during a draining call, explain that the text could not be sent instead of claiming success.

Approved paid-status policy: `active` with a valid synchronized current period can start commercial calls; scheduled cancellation retains access until its effective end. `past_due`, canceled, missing, stale, malformed, or unsupported billing state cannot start new commercial voice. This voice-specific policy does not change existing SMS/web-chat grace behavior. Trial commercial access requires a separate explicit approval and allowance; the private pilot is unaffected.

Add protected per-business preferences, fallback choice, rollout state, and policy revisions. Use business-scoped keys, RLS for permitted owner reads, authorized server writes, and auditable admin changes. Store the access source and settings/policy snapshot on the call.

Audit direct checkout, billing portal, plan updates, and administrator grants so Full Suite stays closed to ordinary acquisition. Do not mutate live Stripe configuration during planning or tests. If a portal change is necessary, present and verify the exact test-mode configuration before a production change.

**Finished when:** unauthorized plans, stale billing, cross-business requests, and generic billing overrides cannot enable commercial voice; the original pilot still works; purchases remain closed.

## Phase 2 — Monthly allowance and reliable accounting

Add separate customer allowance-period and per-call reservation/settlement records. Preserve provider usage independently. Persist an immutable policy/allowance snapshot and period start/end; edits apply prospectively and cannot rewrite completed cycles.

- Use synchronized Stripe subscription periods. Never invent a new paid cycle from the wall clock when renewal information is absent.
- Validate subscription-source freshness before granting a period or upgrade. Existing synchronization can overwrite state from event snapshots; a database lock alone does not reject stale events. Use authoritative, versioned reconciliation so delayed/out-of-order events cannot recreate an expired bucket, restore revoked access, or mint an extra allowance.
- Atomically reserve seconds before accepting a voice call. Lock in one documented order, recheck current access, and prevent concurrent calls from spending the same balance.
- Pin a call to its admission period, including calls that finish after the period boundary. Late provider callbacks update the original call and period only.
- Track customer conversation time from verified voice handoff after ringing/notice through the phone end. Include listening, pauses, and backend waits during that conversation; exclude ringing, preparation, and post-hangup provider closure.
- Capture the start when the first audible AI frame is forwarded and validate that evidence with an immediate uniquely identified phone playback mark. This must add no greeting pause. Run the warning/deadline from a monotonic timer; preserve the pilot's existing provider-time limit separately. Existing `first_audio_at` alone is not proof of audible phone playback.
- Use the verified Telnyx hangup event's original timestamp and identity as end evidence; callbacks cannot overwrite it with arrival time. Missing or contradictory evidence creates a reconciling state. Never substitute provider duration for customer time.
- Settlement replaces a reservation with actual customer seconds exactly once and releases unused seconds. Repeated webhooks, worker reconnects, and cumulative usage snapshots cannot duplicate usage.
- Keep settled usage and deduplication identities independent of deletable conversation/contact history. Deleting a source record cannot refund minutes or permit the call to be counted again. Retain only the minimal non-content accounting data allowed by the account-cleanup policy; remove caller details through the established cleanup path. Filter the original lifetime-pilot totals explicitly by pilot access source so commercial calls never enter that pool.
- Recover abandoned reservations and incomplete settlement through durable jobs. Do not release a reservation while its call might still be active. After termination is proven, retry missing evidence for up to 24 hours; if it remains unavailable, settle only independently verified customer seconds, waive the unproven portion, release the unused hold, and retain an auditable adjustment. Later provider evidence updates cost accounting without silently increasing that settled customer deduction. Show uncertain held time and alert on stuck termination. Verified customer time may be settled independently of a missing provider invoice/usage total.
- Do not convert provider overruns or startup failures into hidden extra customer minutes. Record operational costs separately, alert on overruns, and preserve the no-paid-overage limit.
- A mid-cycle upgrade uses the existing billing period with a one-time prorated allowance based on time remaining. Repeated downgrade/upgrade events cannot replenish already granted minutes. Apply future plan changes at their actual effective time and never revive expired periods.

No Stripe voice usage meter or charge is created in this batch. Signup/booking confirmation texts remain ordinary SMS usage under existing deduplication and messaging checks.

**Finished when:** concurrent admission, renewal, retries, and failure recovery cannot double count or reset minutes; the pilot's lifetime pool remains unchanged.

## Phase 3 — Connect the policy to routing and worker behavior

Persist the primary response decision once per call. Preserve existing owner forwarding and approximately 11-second ringing behavior. Check commercial readiness after an unanswered forwarded call without allowing the voice route to intercept a call already answered by the owner.

- Use the same call-scoped business across knowledge, contacts, signup links, recordings, and actions. Remove pilot assumptions only where required for the closed commercial path; preserve the private-pilot branch.
- Generalize contact/signup capability resolution and maintenance to the authorized call's access source. Keep booking activation and demo routes closed until their separate acceptance work.
- Pass the reserved customer time into the worker, enforce the time limit, and issue a natural advance warning without changing the accepted style guide or confirmation protocol.
- Recheck operational restrictions during calls. Preference changes and ordinary plan expiry do not reroute a call mid-conversation; emergencies and suspension safely close it.
- Distinguish per-business and worker-wide capacity. Reserve/claim global capacity safely across worker processes; a local `/ready` count is advisory, not an atomic guarantee.
- Preserve exactly one eligible fallback text after a technical failure or capacity/allowance denial when enabled. A normal voice call suppresses the generic missed-call text; a requested signup link remains allowed.
- Preserve callback ownership for recording, hangup, and delivery events. Voice recordings must never enter the voicemail handler.

**Finished when:** the integration harness proves independent businesses, call forwarding, closed rollout, minute limits, fallback deduplication, and the existing pilot flow work without changing the voice experience.

## Phase 4 — Owner settings and usage display

Add a compact voice section to existing settings and billing usage:

- Text follow-up / AI voice answering selection, with the optional eligible-text fallback setting.
- Included, used, held for current calls, and available minutes; exact reset date in the business timezone.
- Clear reasons for disabled access: unavailable rollout, plan, payment state, exhausted minutes, or temporary operational issue.
- Approaching-limit and limit-reached notices; remaining voice minutes never appear as SMS parts or web-chat replies.
- Explain what counts as a voice minute and what happens at the limit. Display no paid voice-overage control.
- Preserve existing conversation review, Leads links, protected recordings, and read-only voice transcripts.
- Cover mobile/desktop, loading, errors, stale-state refresh, saved preferences, and history after downgrade.

Customer-path tests use local/isolated business fixtures and Stripe test mode. Production customer rollout remains disabled with an empty allowed-business list. Live acceptance uses only the existing private pilot, whose controls still show its lifetime budget and original routing; do not display a commercial monthly allowance for that exception. Other owners should not receive an invitation to buy an unavailable tier. Public homepage advertising and final commercial feature-list changes belong to the launch batch.

**Finished when:** an authorized test owner can understand the selected mode, allowance and fallback; other plans cannot activate voice through UI or direct requests.

## Phase 5 — Verify, deploy closed, and review

Run focused unit/integration tests, the isolated local database suite, application and worker type checks, production build, and desktop/mobile walkthrough. Use Stripe test mode and mocked AI/Telnyx providers for automated tests; do not make live charges or send test messages to unapproved recipients.

Obtain independent review of billing/access/concurrency changes and two-round review of any deletion changes. Prepare the exact additive migration and deployment artifacts. Apply only the approved migration through the agreed production workflow, then independently verify schema and permissions.

Deploy worker/application in a backwards-compatible sequence with commercial voice routing disabled. Verify service/protocol readiness, existing purchase blocks, pilot settings/budget, and old/new callback compatibility. Test one approved private signup call and confirm one text, one Lead, correct contact details, protected recording playback, and unchanged spoken experience. The user's actual phone test remains necessary; do not infer speech quality from unit tests.

Rollback first disables commercial admission. Drain any calls using the new access source with a compatible runtime and keep compatible settlement/recovery running; only then restore an older application/worker pair that cannot understand those sessions. Retain the additive schema, accounting and history. Never replay signup messages, reset usage, or delete call records during rollback.

**Finished when:** access and monthly-minutes infrastructure is deployed and verified behind closed gates, the pilot still works, and no customer has gained unintended access or charges.

## Required test matrix

- Every plan and subscription state; scheduled/effective cancellations, stale/missing periods, mid-cycle upgrades, repeated plan changes, duplicate/out-of-order renewal events, and billing overrides.
- Preference or entitlement changes between reservation, stream start, and contact confirmation; bounded continuation for the admitted call, denial of new calls, independent SMS eligibility, and immediate emergency revocation.
- Settings/API/RPC authorization; removed owner, unrelated business, reassigned number, compromised client payload, stale access snapshot, and disabled rollout.
- Reservations under concurrency; near-zero balances; current/next period overlap; no rollover; exactly-once settlement; unknown final duration; worker loss/restart and global capacity exhaustion.
- Hangup during ringing/notice/startup/conversation; cumulative provider usage arriving late; duplicate timestamps and conflicting end evidence; preparation time separated from customer usage.
- First audible frame/mark acknowledgment; missing end evidence and customer-favorable adjustment; source-history deletion without allowance refund; stale upgrades unable to mint new grants.
- Exactly one selected primary route; unchanged forwarding; one eligible failure fallback; no duplicate generic text after normal voice; signup SMS counted only in the existing SMS meter.
- Private pilot isolation and unchanged lifetime budget; action confirmations/contact saving/signup delivery regressions; booking remains disabled on the signup pilot.
- Existing SMS/web-chat behavior, Leads provenance, recording authorization/retention, account cleanup, read-only voice UI, and no purchase-path exposure.

## After this batch

1. Verify public greeting/recording behavior, additional approved businesses, booking and calendar invitations, remaining structured failure/call tests, provider invoices, and worker capacity.
2. Release to a small approved group with the commercial package and limits clearly displayed.
3. Coordinate homepage Full Suite bullets, onboarding, checkout/portal pricing, settings, and support documentation. Open purchases only after those checks pass.

This plan does not treat one central sales flag as sufficient evidence that the entire product is ready to launch.
