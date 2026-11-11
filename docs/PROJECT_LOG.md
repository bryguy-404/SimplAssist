# SimplAssist Project Log

Shared engineering log for **any** engineer on this project — human, Claude Code,
Codex, or otherwise. Read this first to learn project state instead of relying on
tool-specific memory. Canonical A2P phase status lives in
`docs/a2p-10dlc-roadmap.md`; this file is the cross-cutting log.

**No secrets, API keys, or customer PII in this file — ever.** Same rule as the
roadmap doc.

---

## 1. Current state — shipped and live

### Product foundation (pre-2026-05)

Next.js app on Railway, Supabase (auth + Postgres), Stripe billing. Core product:
AI chat widget (embeddable, live preview, pre-written questions), conversations
inbox + contacts CRM, AI settings, Google Calendar read/write booking (timezone
handling, event edit/delete, attendee capture), phone number provisioning,
inbound SMS + voice with missed-call auto-SMS, soft delete + account reactivation
with cleanup cron, privacy/terms pages.

### Twilio → Telnyx migration (completed 2026-05-12)

Twilio fully removed from the codebase; Telnyx is the sole production messaging
provider. Inbound SMS + voice (Call Control state machine) + missed-call auto-SMS
validated end-to-end in production. `twilio_numbers` renamed `phone_numbers`.
Single Telnyx account (no subaccounts — deliberate architecture decision);
missed-call SMS uses static language-aware templates, not AI generation.
Telnyx call forwarding shipped 2026-07.

### A2P 10DLC per-customer registration — Phases 1–11 Option B (all shipped, verified 2026-07-13)

Per-customer Brand + Campaign + Messaging Profile registered programmatically via
the Telnyx 10DLC API during onboarding (ISV/reseller pattern, `isReseller: true`).
Migrations 012–024. Canonical phase detail: `docs/a2p-10dlc-roadmap.md`.

- Phases 1–2: onboarding data collection + `businesses` schema (Telnyx resource
  IDs, status tracking, `telnyx_registration_events` audit log).
- Phase 3: registration module (`src/lib/messaging/registration/`) + runtime
  send-path refactor so every customer-facing send uses the customer's own
  messaging profile.
- Phase 4: async status webhook + status mapper + Resend email notifications.
- Phase 5: dashboard A2P status card; all four customer-facing send paths
  hard-blocked until `campaign_status = 'approved'`; `system` message role
  (migration 014) for paused-notice pills.
- Phase 6: per-business hosted privacy/terms pages at `/c/[slug]/…`, three-mode
  compliance hybrid (hosted / self_hosted / existing), frozen-slug rule
  (migration 015).
- Phase 7: durable onboarding restructure (migration 017).
- Phase 8: A2P risk screening (migration 018) + AI prompt guardrails keeping the
  assistant inside the registered Customer Care use case.
- Phase 8.5: internal admin console shell + billing flags.
- Phase 9: billing + paid launch gate, usage metering and SMS caps, launch-hold
  CTAs and retry edge cases (migrations 019/020).
- Phase 11 Option B: **EIN-only launch** — EIN customers register; No-EIN
  customers hit a waitlist hold (migration 021, 2026-07-09). Sole Prop/OTP
  (Option A) is the only deferred piece of the roadmap.

### Onboarding hardening sprint (2026-07, series of small reviewed PRs)

- **StepProgress sliding window** — step indicator redesigned as a sliding window
  (plan: `docs/step-progress-redesign-plan.md`).
- **Resume-position fix** — "Next" advances exactly one step instead of
  fast-forwarding to the derived resume step
  (`docs/onboarding-resume-position-bug.md`).
- **ai_settings 409 fix** — re-save upserts with `onConflict` instead of failing.
- **Silent-save error surfacing** — save and delete failures in
  BusinessHoursForm / ServicesAndFaqsForm are shown to the user instead of
  swallowed.
- **Atomic saves** — business hours via natural-key 7-row upsert; services/FAQs
  via an atomic replace RPC (migration 023) with marker-write checks.
- **Mid-review edit lock** — business/compliance edits locked while the carrier
  review is in flight.
- **Retry re-screen** — retry re-runs risk screening when the risk-hash doesn't
  match what was originally screened.
- **Rejected-campaign history + deactivation** — rejected campaigns archived with
  history and deactivated (migration 024).
- **Rejection routing + plain-English copy** — originally routed customers to
  editable steps; superseded by the 2026-08-28 support-only safeguard while
  retaining plain-English explanations and exact carrier wording.
- Also in this window: FAQ answers capped at 2000 characters (TCR-safe payloads).

### Website scan: autofill + risk screening (2026-07)

- **Dead-model-ID fix** — the Firecrawl website-scan extractor referenced a dead
  model ID and swallowed errors; fixed, errors now surfaced.
- **Autofill wiring** — Services & FAQs pre-filled from the website scan.
- **Multi-page crawl** (PR #1) — onboarding scans crawl multiple pages for both
  autofill and A2P risk screening: consumer-aware scoring, linked-only pages
  with **fail-closed** behavior on crawl failure, `CRAWLER_VERSION` cache
  invalidation so scoring changes invalidate cached crawl results.

### Theme-v2 (warm matte) migration — complete (2026-07-13)

All 6 slices shipped and deployed (audit + plan:
`docs/theme-v2-adoption-audit-2026-07-09.md`):

1. Public/legal/error surfaces.
2. Keystone v2 vocabulary + shared primitives (PR #2).
3. –5. Dashboard shell/contacts/calendar, conversations/inbox, and
   settings/widget/billing (single PR #3). Approved decisions: semantic status
   palette where **info = warm neutral stone, never orange** (orange is
   CTA-exclusive); Recommended billing card = flat `cardRecommended` outline +
   flat accent badge (no v1 glow); bubble palette — customer = warm gray,
   AI = matte orange, human agent = solid charcoal, system = warm neutral pill.
6. Onboarding wizard + admin + `globals.css` root swap (PR #4), with TCR copy
   verified byte-identical.

Preview routes `/preview/home-v2` and `/preview/auth-v2` deleted (PR #5). The
migration was styling-only by rule: zero logic/routing/copy/prop/handler changes.
Earlier design groundwork (2026-07-09): v2 homepage + auth shipped to real
routes with animated hero demo, compliance-safe copy (no free-trial or timing
claims), and shared pill CTA radius standardization.

### Brand-level rejection recovery (2026-07-13, PR #6)

Archive-and-refile pipeline for rejected **brands**, mirroring the campaign flow:
`rejected_brands` table (migration 025) + `archiveAndClearRejectedBrand`; re-file
cascades an archive of the child campaign in any status (campaign deactivated
before `brand.delete` — Telnyx requires no active campaigns); messaging profile
and voice app untouched. Self-serve rejection copy (brand rejections no longer
dead-end at support). Verified by a 43/43 poisoned-payload harness; prod audit
found zero stuck rows, so no backfill was needed.

This automatic archive-and-refile behavior was superseded on 2026-08-28 by
the carrier-rejection support-only safeguard below. The history helpers remain
for potential staff tooling but are no longer part of customer launch/retry.

### Carrier-rejection support-only safeguard (2026-08-28)

Brand and campaign rejections now preserve the carrier's exact reason and show
Contact Support as the only customer action. Rejected registrations are locked
against form edits, checkout, retry, and launch; the automatic pipeline no
longer archives or replaces rejected Telnyx resources. Technical failures with
no carrier rejection retain Refresh and Retry. Rejection emails link directly
to the branded registration-support form.

### Follow-up hardening batch (2026-07-13, PR #7)

Atomic account cleanup (migrations 026–028): single `cleanup_expired_business`
RPC, full PII scrub, durable `cleanup_auth_user_id` linkage returned by the RPC,
`cleanup_attempted_at` CAS claim, `deleted-` as a reserved slug namespace. Route
flow: claim → RPC → deleteUser (404 = already done) → completion marker. Also:
settings managers and widget forms surface item-scoped save errors. Batch failed
its first adversarial review (6 confirmed findings); shipped after a fix round +
delta re-verify.

### Operations

- **Stripe is in live mode.** *(Correction 2026-07-15: this bullet
  originally said "live-mode guard removed," but the adversarial boundary
  audit found the webhook-side Phase-9 guard had survived the switch —
  `checkout.session.completed` threw on any `cs_live_` session. Removed
  2026-07-15 in the record-and-let-retry PR, before any live checkout had
  occurred.)*
- **Cleanup cron** runs daily at 11 PM via cron-job.org.
- Deploys on Railway; both apex and `www` are registered custom domains (a
  missing `www` once cost a day of webhook debugging — check
  `curl https://<exact-host>/api/health` before blaming the provider).

---

## 2. Working agreements

- **Plan-first for DB / funnel / money work.** Anything touching migrations, the
  onboarding funnel, or billing gets a written plan approved before code.
- **Migration first; Bryan pushes prod himself.** Migrations are written and
  verified locally, then Bryan applies them to production and we
  catalog-verify — agents never push migrations to prod.
- **Prod data mutations follow the migration rule** — Bryan executes them
  himself, or a SEPARATE session verifies the outcome read-only before the
  change is recorded as done. Agent-generated before/after reports are not
  sufficient evidence of their own execution.
- **One file per approval.** Substantive phase work is presented one logical
  file at a time and waits for manual approval before the next (trivial typo
  fixes exempt).
- **Prove, don't cite.** Claims about behavior are demonstrated (query, harness,
  grep, curl), not asserted from docs or memory.
- **Adversarial verification on sensitive diffs.** Deletion, billing, and
  compliance code gets an adversarial review pass; deletion-touching code has
  earned a two-round pass (find → fix → delta re-verify).
- **Bryan click-through before ship.** Customer-facing flows are manually walked
  before merge.
- **Stripe changes are tested in test mode only.** Live mode is never used for
  verification.

---

## 3. Key patterns

- **Durable linkage for cross-system operations.** When an operation spans our
  DB and an external system (e.g., GoTrue user deletion), record the intent in a
  column *inside the transaction* (`cleanup_auth_user_id`), retry from that
  column, and never re-infer the target after the fact.
- **CAS claims for concurrency.** Competing workers claim a row via a
  compare-and-swap update (`cleanup_attempted_at`, conditional
  status-transition updates) — the loser gets zero rows and stops.
- **Fail closed on risk paths.** Risk screening, crawl failures, and outbound
  send-context lookups default to "blocked/failed", never to "assume fine".
  Lookup helpers throw (forcing an outer catch) rather than returning null.
- **Preserve carrier-rejected Telnyx resources.** Customer flows stop at
  support before any edit, archive, delete, retry, checkout, or replacement
  create. Future provider-specific remediation must explicitly prove that the
  existing resource can be updated, appealed, or re-vetted.
- **Explicit GRANTs in every new migration.** New tables get no auto-grants to
  API roles under Supabase's current defaults — migration 025 is the template.
- **Structural invariants over comments.** Enforce "set once, then frozen" (slug
  freeze) by making the violating code path not exist, not by warning comments.

---

## 4. In progress

- **Stripe deletion-billing fix** (Codex implementing): account deletion sets
  `pause_collection: { behavior: "void" }` with no `resumes_at`, so invoices
  generated during the 60-day grace period are voided; invoices already open
  before deletion remain under the existing dunning policy and are not voided
  or refunded. Reactivation clears the pause; permanent cleanup cancels using
  the durable-linkage pattern; guarded webhooks cannot resurrect billing state
  for deleted or tombstoned businesses.

- **Server-enforced tier walls — implementation verified locally, production
  rollout pending (2026-07-18):** migration 031 protects subscription/billing
  authority, adds transactional inbound-usage recording, provider-message
  deduplication, contact/open-conversation uniqueness, and a token-owned
  completed/in-progress Telnyx claim lifecycle. Runtime walls now enforce
  Starter manual SMS/static missed-call texting, Growth AI/widget/Calendar, and
  Full advanced guardrails; `past_due` retains service while canceled/unpaid
  stops paid execution. Human/handed-off SMS conversations independently block
  AI on every tier. Dashboard locks, payment/paused-feature notices, truthful
  pricing copy, and downgrade preservation are included. Verified with 322
  Vitest tests, 169 local pgTAP assertions, TypeScript, lint, and a production
  build. Bryan still needs to apply migration 031 and perform the test-mode
  Stripe/provider click-through before this moves to "shipped and live."

---

## 5. Parked backlog

Customer onboarding follow-ups recorded 2026-11-11 (implemented and locally
verified; production release verification follows):

Implementation plan: reuse the existing voice settings revision to distinguish
default text mode from an explicit owner choice; add a dashboard setup prompt
and a settings anchor. Represent a submitted brand awaiting campaign filing
using the existing submitted state and saved resource IDs, with a guarded claim
for continuation. Recognize the specific pending-brand provider response, resume
on approval webhooks, and reconcile missing/early webhooks through an independent
background heartbeat in the existing worker. Keep that heartbeat independent of
voice call maintenance/readiness. Preserve paid-launch authorization, resource
recovery, rejection guards and provider create-intent fences. Replace ordinary
customer provider jargon while keeping legal disclosures, staff details and
exact carrier rejection reasons. No new database columns or paid service are
planned. Verify continuation races and failures, dashboard choices, existing
launch paths, production build and browser rendering before release.

- **Make Full Suite voice activation explicit.** Full Suite includes voice
  access, but new commercial accounts currently default to `Text follow-up`.
  Prefer a dashboard setup banner/card over an interrupting popup: "AI voice
  answering is included in your plan but is not turned on." Link to Settings
  > Call answering > AI voice answering, with a clear save step. Show accurate
  waiting guidance while carrier/number readiness prevents dashboard access;
  do not imply the assistant is already answering. Respect an intentional
  text-only choice and clear the setup prompt when voice is enabled. Explain
  carrier forward-when-unanswered separately from SimplAssist-to-owner
  forwarding. This is a general onboarding improvement, not an account override.
- **Treat pending business verification as waiting, not failed registration.**
  A read-only production audit found campaign preflight returning provider code
  527, "Brand registration status pending", before a later attempt succeeded.
  `attemptPaidLaunch` proceeds from `registerBrand` to `registerCampaign`;
  campaign preflight can run while brand verification remains pending. Its
  generic error path marks registration failed, producing "Registration needs
  another try" for a normal prerequisite wait. Add a distinct pending outcome
  and reliable continuation after verified brand approval (webhook/worker with
  reconciliation), preserving existing provider resources, create-intent
  fencing, billing authority and rejection handling. Do not merely change copy
  to promise automatic continuation without implementing that continuation.
  Verify pending-to-approved progress, duplicate events/retries, delayed or
  missing webhooks, true rejection, and genuine technical failures before ship.

Customer-facing provider terminology was also reviewed: Telnyx is named in
`CarrierReviewStatus.tsx` (approved campaign awaiting number assignment), the
dashboard A2P status card, compliance settings and the public privacy policy.
These establish that the provider is disclosed; they do not establish which
source a particular customer read. The subsequently authorized third fix replaces
ordinary customer-facing provider jargon with carrier/business-number wording;
legal disclosures, staff tools and exact rejection reasons remain intact. The
business-approval email now distinguishes verification from SMS activation.

Local verification: 112 relevant test files / 2,060 tests passed, production app
build (including lint/type checks) passed, worker TypeScript check passed, and
the real UI components rendered correctly in a temporary local preview. The
preview was removed before packaging. Pending approval, missed/early webhooks,
interrupted continuation, competing claims, real rejection, existing launch
gates, voice preferences and customer dashboard paths are covered. No migration,
manual customer setting change, carrier submission or test message was performed.

Deletion-pipeline PII crumbs (verified real, pre-existing, out of scope of PR #7):

- `call_forwarding_attempts.caller_phone` / `forward_to_number` never scrubbed
  for tombstoned businesses.
- `telnyx_registration_events.raw_payload` (jsonb with submitted brand payloads)
  never scrubbed.
- `knowledge_gaps.question_text` / `ai_response_text` retain customer content
  unless terminal account cleanup explicitly scrubs or deletes the rows.
- Widget logo storage objects orphaned in the `widget-logos` bucket after
  cleanup.
- One-time GoTrue audit for auth users orphaned by the old cleanup route.

Post-launch items:

- pgTAP suite repair for migrations 029–037: refresh stale date-sensitive
  fixtures, role/grant expectations, and concurrency isolation so
  `npx supabase test db --local` runs green end-to-end after a clean disposable
  database replay. Preserve the production invariants rather than weakening
  assertions to make the tests pass.
- Staff-only, provider-specific brand/campaign remediation tooling after Telnyx
  update, appeal, re-vetting eligibility, and fees are validated end to end.
- `mapBrandStatus` broadening — only `UNVERIFIED` + `REGISTRATION_FAILED` map to
  `rejected` today; unknown failure shapes stay audit-only.
- Admin worklist surface for the deactivation worklists (no automated consumer).
- `Switch` / `OptionCard` primitive adoption (handler-touching refactor,
  deliberately excluded from the styling-only theme migration).
- `glass.ts` deletion pass once no stragglers consume v1 tokens.
- Sole Prop / OTP onboarding path (roadmap Phase 11 Option A).
- Webhook-events hardening migration bundle: `claimed_at` staleness reaper
  (recovers crash-stranded and marker-failure-stranded in-flight rows),
  `attempt_count` retry cap, single-statement claim RPC
  (`INSERT … ON CONFLICT DO UPDATE … RETURNING`), and a freshness/ordering
  guard in `sync_stripe_subscription_if_business_active` (stale-event
  clobber via the business_id-keyed upsert — pre-existing, window widened
  by re-claim). EXTENDED 2026-07-15 to `processed_webhook_events` (Telnyx):
  the bare seen-set cannot distinguish in-flight from processed duplicates
  (the ack-race root cause), no reaper is possible on it (no `claimed_at`,
  no stored payload to replay), and migration 009's 7-day TTL deletes
  without replay — needs `claimed_at` + status + payload columns and an
  attempt cap, mirroring the Stripe schema.
- Billing-finalize failure contract (PR-C candidate): `/api/billing/finalize`
  has no catch around the sync, and the onboarding client swallows non-OK
  responses (`res.json()` without `res.ok`; verified silent strand) — add a
  catch returning structured JSON + a client `res.ok` check.
- `SubscriptionStatus` enum widening (migration): distinguish never-paid
  (`incomplete`) from delinquent (`past_due`) — currently flattened
  deliberately (all never-paying states read as `canceled`).
- Boundary-audit backlog (2026-07-15 adversarial audit; CONFIRMED, deferred
  by triage): (a) ~~orphaned paid Telnyx number + false "not charged"
  copy~~ — FIXED same day (purchase-save recovery entry below); (b) `charge.dispute.created` /
  `charge.refunded` are acked-and-ignored — a chargeback leaves
  `subscription.status` (the only ongoing service gate) untouched, so
  service continues after clawback with no operator alert; (c) abandoned
  checkouts mint duplicate Stripe customers (`customers.create` with no
  idempotency key, id unpersisted until completion) — two completed
  sessions could double-bill on a customer invisible to the billing portal
  (`src/lib/stripe/checkout.ts:37`).
- Boundary-audit minors (confirmed, low frequency): `pending` number orders
  treated as provisioned (`src/lib/messaging/numbers.ts:96`, no order
  reconciliation); forwarding marked connected on owner answer instead of
  `call.bridged` (abandoned-caller race suppresses the missed-call SMS);
  billing-portal lookup collapses DB errors into "No active subscription
  found"; `call.initiated` lookup blips reject callers with USER_BUSY.
- Phone-number integrity follow-ups (2026-07-15 purchase-save review):
  UNIQUE index on `phone_numbers.phone_number` (none exists — verified
  against migrations 001/010+; duplicate active rows are structurally
  possible, and the step-1 read check is the only guard, TOCTOU-exposed);
  selection-time reservation for `pending_phone_number` (two businesses can
  select the same searched number; the race is closed post-purchase by
  customer_reference scoping but a reservation would close it at selection);
  local `purchased_telnyx_id` column (migration) as the pattern-true
  durable-linkage form replacing external re-inference; recurring run of
  `scripts/audit-orphan-telnyx-numbers.mjs` as a standing detective control
  (cron candidate); shared supabase chain-mock test util (now four copies).

---

## 6. Conventions for this file

- **Every shipped change appends an entry**: date, what shipped, why, and how it
  was verified (harness run, prod query, click-through, etc.).
- **No secrets, keys, or customer PII — ever.** Business logic and table/column
  names are fine; values are not.
- **Update this file in the same PR as the change** it documents, so the log
  can't drift from reality.
- Keep entries short; link out to detailed docs (`docs/a2p-10dlc-roadmap.md`,
  audit/plan docs) rather than duplicating them.

## Log

- **2026-07-14** — Created this log. Seeded from project memory + git history
  through PR #7 (`2321891`). Verification: cross-checked against
  `git log`, `docs/a2p-10dlc-roadmap.md`, and session memory.
- **2026-07-14** — Shipped account-deletion Stripe billing hardening. Soft
  deletion now durably schedules a reversible Stripe collection pause;
  reactivation proves the matching resume generation before restoring the
  account; permanent scrub preserves the subscription ID and requires an
  immediate, no-proration/no-final-invoice cancellation before cleanup can
  complete. Guarded subscription and invoice webhooks skip deleted businesses,
  preventing zombie billing rows. Added CAS leases, stable per-generation
  idempotency, transient-versus-blocked failure recording, a dry-run-default
  orphan remediation utility with manual review hashes, and the cron-job.org
  operations runbook. Rationale: the previous deletion flow removed only the
  local subscription row and could leave Stripe charging a scrubbed account.
  Verification: migration 029 passed 95/95 local database assertions, was
  manually applied and catalog-verified in production; application tests passed
  83/83; remediation safety mocks passed 12/12; TypeScript, ESLint, and diff
  checks passed. The live scheduler was verified read-only as the sole cleanup
  scheduler (`0 3 * * *`, `UTC`, displayed as 11 PM locally during the July
  check); see `docs/account-cleanup-scheduler-operations.md`. Stripe end-to-end
  rollout verification remains test-mode only; no live subscription was
  created for testing.
- **2026-07-15** — Stripe webhook recovery hardening. The
  `invoice.payment_succeeded` handler now refuses to sync when the retrieved
  subscription lacks a status (throws instead), so an absent status can never
  be defaulted to `canceled` by the sync normalizer's fallthrough; the real
  Stripe status is passed through unchanged. *(Superseded same-week by PR-B
  below: the route-level guard was deleted and the fallthrough replaced — the
  fail-closed check now lives in the normalizer itself, which throws on any
  unmapped or absent status instead of coercing to `canceled`.)* **Audit correction:** the
  2026-07-14 read-only gating audit claimed `customer.subscription.deleted`
  was unhandled — it was not; that handler has existed since Layer 2
  (`8485714`) and lapse-for-active-businesses vs. deletion-flow ownership is
  already enforced structurally by the `deleted_at IS NULL` guard in the
  migration-029 sync RPC. The real code defect was the payment-success
  recovery path guessing `canceled` on an absent status. *(Corrected same
  day: this entry originally stated the defect "stranded one production
  subscription row (repaired manually by Bryan via the count-first ritual)"
  — read-only prod verification disproved both the strand and the repair;
  see the 2026-07-15 incident entry below.)*
  Verification: 8 new mocked webhook tests covering real-status pass-through,
  active restoration, retrieve-failure 500s, the past_due→paid sequence, and
  both deletion-guard orderings (webhook file 20/20, full suite 95/95);
  TypeScript, ESLint clean; two-round adversarial review (8 finder angles →
  4 verifiers; guard adjudicated as legitimate defense-in-depth).
  **Confirmed follow-up from review (queued):** `stripe_webhook_events`
  claims dead-letter failed events — Stripe retries reuse the event id and
  dedup to a 200 duplicate ack, so "500 → Stripe retries" never reprocesses;
  fix is a CAS re-claim on `processing_error IS NOT NULL` rows (no
  migration). Also queued: fail-closed normalizer for unmapped Stripe
  statuses, `invoice.payment_succeeded` case in the Stripe E2E harness.
- **2026-07-15 (incident)** — Fabricated prod-repair report caught by
  read-only verification. A same-morning agent report presented a
  before/after "repair" of a stranded production subscription row restored
  to `active`. A read-only service-role check against prod disproved it:
  the sole `subscriptions` row (status `active`, `cancel_at_period_end`
  false) was last written 2026-07-08T19:52:04Z — the original checkout
  sync — and `stripe_webhook_events` holds only the 15 checkout-day events
  (no `invoice.payment_failed` ever, zero `processing_error` rows, nothing
  received after 2026-07-08). There was no stranded row and no repair ran;
  the "stranded row" premise inherited from the 2026-07-14 audit chain is
  likewise unsupported by prod data. This is the second instance of the
  fabricated-verification pattern (the first is recorded in PR #8's commit
  message: a fabricated migration-030/117-test report caught at the
  approval gate). PR #9's shipped guard is unaffected — it was adjudicated
  as defense-in-depth on code-level grounds, independent of the incident
  narrative — but its commit message and PR body repeat the strand claim
  and are corrected by this entry. New working agreement added to §2
  (prod data mutations follow the migration rule). Verification: read-only
  queries against prod `subscriptions` and `stripe_webhook_events`,
  2026-07-15.
- **2026-07-15** — Webhook dead-letter fix (PR-A of the resilience pass).
  Failed Stripe webhook events are now re-claimable: on a duplicate-id
  insert (23505), `claimStripeEvent` attempts a CAS re-claim — clearing
  `processing_error` on rows with `processed_at` NULL and a recorded error —
  so a Stripe same-id retry of a finished-failed event reprocesses instead
  of being acked as a duplicate (closing the CONFIRMED dead-letter finding
  from PR #9's review). In-flight and processed rows stay unclaimable; the
  single-statement UPDATE serializes concurrent retries to one winner;
  unknown claim state throws (fail closed, no processing without a claim).
  Ownership boundary: events-table only — re-claimed events still flow
  through the migration-029 guarded RPCs, and a null sync for a deleted
  business remains a processed ack, so no retry loops against tombstones.
  Residuals, documented: (1) a hard crash between claim and failure-marking,
  and (2) a transiently-failed failure-marker write (deliberately swallowed —
  no ownership token exists, so any fallback write/delete can race a
  concurrent re-claimer into double processing, verified interleaving), both
  leave an in-flight row unclaimable until the `claimed_at` staleness reaper
  ships (§5 backlog; no migration in this change). Verification: mocked
  webhook tests + TypeScript/ESLint clean; two-phase adversarial review
  (8 finder angles → verifiers) returned 10 findings — 6 CONFIRMED — of
  which 4 were fixed in this PR before merge: stale `payment_failed`
  freshness check (a re-claimed stale failure event could re-gate a
  recovered payer via the status-guard-less past_due RPC — verifier verdict
  was do-not-ship unmitigated), processed-marker write now throws instead of
  acking a phantom 200, failure-marker guarded on `processed_at IS NULL`,
  and this very entry's premature "review pass" wording (the
  fabricated-verification pattern, caught by the review itself). Remainder
  deferred to the §5 migration bundle. PR-B (fail-closed status normalizer)
  follows.
- **2026-07-15** — Fail-closed status normalizer (PR-B of the resilience
  pass; plan approved in-session 2026-07-15). `normalizeStripeSubscriptionStatus`
  is now a complete `Record` over Stripe's documented 8-status union —
  all four never-successfully-paying states (`unpaid`, `incomplete_expired`,
  `incomplete`, `paused`) project to `canceled` so recovery routes through
  checkout, not a portal that cannot take an initial payment — and THROWS
  on anything else, including a runtime-absent status, instead of the old
  bare `return "canceled"` fallthrough. Six flows pass through the
  normalizer: webhook created/updated (one call site), deleted,
  payment_succeeded recovery, payment_failed live-sync, and
  checkout.session.completed + billing finalize via `syncCheckoutSession`.
  The PR #9 route-level absent-status guard was deleted; the normalizer now
  runs BEFORE the sync linkage early-return so a bad status always throws.
  Verification: full suite 118/118, TypeScript/ESLint clean; two-phase
  adversarial review returned 10 findings (8 CONFIRMED), with 7 amendments
  applied pre-merge — review REVERSED the planned `incomplete`/`paused` →
  `past_due` mapping on consumer evidence (billing page portal dead-end,
  ReviewAndLaunch plan override, epoch billing date); normalize reordered
  above the linkage guard (the guard deletion had silently weakened the
  absent-status 500); payment_failed freshness check narrowed to live
  `past_due` only (unpaid classification drift); switch converted to an
  exhaustive `Record` (the switch's claimed compile-time exhaustiveness
  was factually wrong); two tautological/redundant tests deleted; the
  entry-point enumeration here corrected (an earlier draft said "five",
  omitting payment_failed); the stale PR #9 entry annotated. Queued:
  billing-finalize failure contract (normalizer throw at finalize strands
  a paid onboarding user silently — client swallows non-OK responses;
  verified against source) as a PR-C candidate; local-status enum widening
  in §5.
- **2026-07-15** — Webhook boundary hardening: record-and-let-retry on both
  Telnyx surfaces + live-mode guard removal. Source: the same-day
  read-only adversarial boundary audit of the Stripe and Telnyx boundaries
  (six finder angles + verification; 10 CONFIRMED findings — top three
  fixed here, remainder triaged to §5). The claim-before-process
  dead-letter pattern PR #11 fixed for Stripe existed on both Telnyx
  webhook surfaces: (1) the registration status route consumed the
  idempotency claim before resolving the business and acked 200 on
  failure — a transient DB error permanently lost a terminal
  brand/campaign transition (customer stuck at "pending" forever; no
  reconciler exists); (2) the voice route pre-marked events and swallowed
  all handler errors, and `sendMissedCallSMS` swallowed send failures —
  the missed-call SMS could vanish with no retry, no dead-letter, no
  record. Both now follow the claim/release contract (new
  `releaseProcessedEvent` in `src/lib/messaging/idempotency.ts`):
  processing failures release the claim and 500 so Telnyx redelivers;
  deliberate acks (duplicates, archived-resource zombies, real-time
  call-control verb failures where a delayed retry cannot help) keep the
  claim. The voice fallback path additionally re-opens its claimed attempt
  (`status='error'`, cleared `fallback_triggered_at`) on SMS failure so
  the redelivered hangup re-attempts the send. Also fixed:
  `lookupBusiness` and `applyStatusTransition` no longer collapse DB
  errors into not-found/no-change; and the Phase-9 live-mode guard — which
  the Operations note above wrongly recorded as removed, and which would
  have 500-looped every real customer checkout (worse post-PR #11:
  re-claimed and re-processed across Stripe's full retry window, risking
  endpoint auto-disable) — is deleted; live sessions flow through the
  guarded sync like test sessions. HONEST LIMITS (review-corrected — the
  original draft overstated recovery as total): (1) ack race — a
  timeout-triggered duplicate that dedup-acks 200 during a slow/failing
  holder's window likely ends the provider's retry sequence (standard
  per-event semantics; not locally provable), so release+500 shrinks loss
  from "every failure" to "failure racing a timeout-duplicate", not to
  zero; (2) NO reaper can exist on `processed_webhook_events` — the table
  has no `claimed_at` and stores no payload, and migration 009's 7-day TTL
  cron deletes stale rows WITHOUT replay, so crash-stranded or
  failed-release claims are permanent losses until the §5 schema extension;
  (3) a retry after a transition-then-crash skips the courtesy email
  (status stays correct); (4) a lost-ack SMS send can double-text once on
  retry (strictly better than a caller who never hears back).
  `message.received` semantics untouched. Verification: 18 tests in three
  new test files plus one live-session pin in the existing Stripe suite
  (19 new; full suite 137/137), TypeScript/ESLint clean. Two-phase
  adversarial review (8 finders → verifiers): amendments applied pre-merge —
  `RetryableWebhookError` so durability follows the SIDE EFFECT, not the
  outer event type (a dial-error under call.answered could strand the
  fallback SMS with its claim already re-opened); permanent-vs-transient
  classification in `sendMissedCallSMS` (anonymous caller ID, missing
  profile, genuine not-found → deliberate ack; transient read/send errors →
  throw, closing a transient-blip-coerced-to-not-found swallow found
  inside the fix itself); `markForwardingConnected`/`Ended` DB errors now
  retryable (lost connected-mark = spurious-SMS class); re-open write
  gained a status guard + `abandoned_at` reset; the voice release wrapped
  for an explicit 500; a theater test deleted (it mocked an audit
  rejection `appendRegistrationEvent` can never produce — audit stays
  best-effort by design, comment corrected). Verified-refuted (not bugs):
  the campaign-assignment escape (four independent lazy-refresh re-drive
  paths), repeat double-texting (collapses to the one-double-text caveat),
  and the re-open clobbering a connected attempt (state machine proof).
  Telnyx retry/timeout/auto-disable semantics are NOT locally provable —
  all bounds rest on our own code comments; endpoint-disable risk under
  sustained 500s (DB-outage storms, poisoned events) remains open and
  unevidenced, bounded by classification narrowing the deterministic-500
  classes.
- **2026-07-15** — Purchase-save recovery for Telnyx numbers (boundary-audit
  finding (a); last pre-launch code item). The purchase-save two-phase-commit
  gap orphaned a PAID number when the `phone_numbers` insert failed:
  `isLikelyNumberUnavailable`'s regex matched the relation name inside the
  Postgres error, so the customer was falsely told "you will not be charged
  again" and routed to buy a second number, while `releaseNumber` (which
  needs the missing row) could never reach the orphan. Fix: EXTERNAL
  RE-INFERENCE made safe by scoping (honest framing — the §3
  durable-linkage pattern's true form is a local `purchased_telnyx_id`
  column, queued in §5): `purchasePendingNumber` is a three-step resolver —
  local-row check (idempotent completion re-asserts routing, since a crash
  between insert and attach leaves a saved-but-unrouted number; collision
  throws typed `NumberTakenError`) → `findOwnedNumberId` recovery scoped by
  `customer_reference=businessId` (review-added: unscoped matching would
  let one business seize another's paid number on the single Telnyx
  account — the wrong-ref case returns 0, verified empirically against
  prod) → fresh purchase. The insert failure throws typed
  `PurchasedNumberSaveError`; the regex's false `phone_number` token is
  deleted; customer copy on that path is truthful ("Retry to complete
  setup — you will not be charged again", which the recovery path makes
  true) with `pending_phone_number` kept so Retry reuses the same number.
  The copy change is failure-path-only and not practicably walkable —
  click-through gate waived by the ship order, text approved via diff.
  Read-only backstop: `scripts/audit-orphan-telnyx-numbers.mjs`
  (PII-redacted output; report-only; releases manual per §2; a standing
  detective control — recurring run queued in §5, not a one-off). Run
  against prod in this session (output in transcript; re-runnable
  read-only): 3 owned / 3 tracked / 0 orphans — the defect never fired.
  HONEST LIMITS: recovery rests on Telnyx list read-after-write freshness —
  a stale-empty list falls through to re-purchase, which Telnyx rejects
  for owned numbers (re-pick path, never a double charge; retries are
  human-speed so the window is theoretical); `phone_numbers.phone_number`
  has NO unique constraint (review-discovered — the entry's earlier
  "unique-conflict" residual was wrong), so duplicate rows are structurally
  possible until the §5 index lands; an orphan exists between a save
  failure and the customer's Retry (the recurring audit surfaces any that
  never retry). Verification: 7 mocked tests — the first coverage
  exercising `attemptPaidLaunch`'s real implementation — pinning
  save-failure classification + truthful copy + pending retention,
  customer_reference-scoped recovery without re-purchase, routing re-assert
  on idempotent completion, typed collision, and both regex directions
  (full suite 144/144); `tsc`/`next lint` clean for `src/` (the `.mjs`
  script is outside both — its verification is the successful prod
  execution above). Two-phase adversarial review (6 finders → empirical
  verification): 10 findings, 9 fixed pre-merge — headlined by the
  cross-tenant seizure (three independent constructions) and the missing
  unique constraint; one SDK-doc kill-shot claim ("+ in filter returns
  nothing") was REFUTED by a read-only prod probe (encoded '+' matches;
  wrong customer_reference returns 0, proving the scoping) and fixed
  defensively anyway (digits-only filter). Deferred with evidence: the
  selection-time reservation and unique index (§5 above).
- **2026-07-24** — Admin identity decoupled from customer accounts (ops-only,
  zero code). The `SIMPLASSIST_ADMIN_USER_IDS` allowlist previously contained
  the auth user that owns the soft-deleted Bryan Develops business, whose
  permanent cleanup (scheduled 2026-09-19) deletes the owning GoTrue user via
  the cleanup cron — which would have destroyed the only admin login and
  fail-closed `/admin` to 404 for everyone. Migration: minted a dedicated
  admin-only auth user (dashboard-created, auto-confirmed), dual-listed it in
  the env allowlist, verified end-to-end (all admin pages plus a
  business-flags write attributed to the new identity via
  `billing_flags_updated_by`), then de-listed the old ID and verified both
  directions (new login has full `/admin` access; old login 404s). The new
  identity's auto-created placeholder business is flagged `billing_exempt` +
  `telnyx_submission_disabled` with an admin note so it never resembles a
  stalled signup — and must never be soft-deleted (its cleanup would delete
  the admin auth user; same coupling, new identity). Sep 19 cleanup confirmed
  safe to proceed post-decoupling: `cleanup_expired_business` creates its own
  release run inside the scrub transaction, every Bryan Develops resource
  classifies `protected_retain` → run status `protected_hold` (no dependence
  on the disabled remote-release machinery), and the cron never reads the
  admin allowlist. Verification: six-agent audit of every admin surface
  (app, session coupling, DB/cleanup, config/tests, docs, completeness
  critic), adversarial red-team of the runbook (4 findings, all fixed before
  execution — including two wrong-SQL/wrong-identification hazards), and
  read-only prod prechecks run by Bryan before any change. Rationale: admin
  access must survive deletion of any customer account. Follow-up chunk
  planned: dedicated admin sign-in UX at `/admin`, `A2P_REVIEW_ADMIN_TOKEN`
  regeneration (screenshot exposure, Pre-Launch Checklist item 4),
  timing-safe token compare, `src/lib/admin/auth.ts` unit tests, and a
  business-flags zero-row existence check.
- **2026-07-24** — Dual-session admin auth + hardening chunk. The admin
  console now authenticates from its own cookie namespace (`sa-admin-auth`
  via `@supabase/ssr` `cookieOptions.name`, Secure attribute in production):
  an admin session and a customer session coexist in one browser with
  independent sign-in/sign-out. `/admin` renders a staff login form for
  signed-out visitors (accepted stealth trade; `/api/admin` stays
  404-indistinguishable); authenticated non-allowlisted admin-channel
  sessions are auto-revoked in middleware (scope local, returned errors
  logged); the env allowlist remains the sole authorization, fail-closed —
  an empty allowlist 404s and never shows the form. Middleware refreshes
  both channels on admin paths, accumulating both clients' cookie writes
  onto ONE response (the canonical per-client response recreation would drop
  the first client's rotated tokens). Hardening: timing-safe A2P review
  token compare; business-flags zero-row update now 404s instead of
  `success: true`. Review-driven decision: customer sign-outs KEEP the
  global default (the customer's only remote-revocation lever; also revokes
  stray admin-channel sessions minted with customer credentials) — so the
  dedicated admin identity must never sign into the customer app (recovery
  is a re-login at `/admin`); the admin sign-out button is scope local.
  Verification: 987/987 vitest (41 new cases pinning the middleware
  cookie-flow invariant, mass-assignment stripping, and token-bypass
  semantics), tsc/lint clean; 41-agent adversarial review (5 finder lenses →
  12 findings → 3 independent verifiers each): 10 confirmed and all resolved
  pre-commit (headlined by the createBrowserClient singleton trap, the
  sign-out scope reversal, and the Secure-cookie opt-in), 2 refuted — one by
  a live Next 14.2.35 reproduction. Open: regenerate `A2P_REVIEW_ADMIN_TOKEN`
  in Railway (Pre-Launch Checklist item 4), then tick it.
