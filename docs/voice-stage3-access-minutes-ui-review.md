# Voice access and minutes: UI and independent review

September 17, 2026. Implementation review of the closed commercial voice path. This report is not a production rollout approval.

## Owner UI

The settings and billing pages share a server-projected voice settings type and usage component. Ordinary accounts receive no activation invitation. The designated private pilot receives a read-only lifetime display; existing pilot controls remain separate.

Commercial accounts see included, used, held, and available minutes, with 80% and 95% notices based on used plus held time. An ended billing period is labeled as a previous cycle with unused minutes, without a future reset promise or current-cycle warnings. Current reset dates use the business timezone. The owner can choose text, voice when authorized, and eligible text fallback; no voice overage or purchase control is present.

Changes use a revision-checked PATCH. A forbidden or stale response refreshes server state once and never repeats the mutation. If that refresh fails, editing stays blocked until a successful refresh. Missing initial settings do not crash the rest of either page. History links remain available after loss of voice access. Owners with an existing voice preference can still disable optional text fallback while voice is unavailable; selecting voice from text continues to require current authorization.

Validation completed:

- 91 tests pass across the voice component and settings/billing page suites, including fallback-only changes under all five unavailable statuses. The final combined focused run, including billing reconciliation, the settings loader, and API tests, passed 206 tests across seven files.
- ESLint passed for the component, its tests, the pure type, and integrated pages after the ended-cycle change.
- Whitespace validation passed.
- Root owns the final full-worktree checks and desktop/mobile browser verification.

The browser walkthrough found an extra runtime `revision` property in the UI draft being sent to the strict PATCH endpoint. Serialization now explicitly includes only `mode`, `textFallbackEnabled`, and `expectedRevision`. A regression starts with the actual spread preferences object and verifies the request has exactly those three fields. The component and strict API suites pass all 49 tests after that correction; API validation remains strict.

## Independent billing and access review

Reviewed the Stripe reconciliation helper and synchronizer, webhook changes, owner settings server loader/API, and migrations 081–083. No provider requests or database writes were performed for this review.

Resolved findings:

1. A delayed event for another subscription could replace the canonical subscription and create another allowance. The reconciliation ticket now validates the stored customer/subscription identity under the business lock. A rejected source returns an explicit ignored result; application code does not fall back to the legacy synchronizer. The transactional apply wrapper repeats the binding check.
2. Full-plan renewal/recovery could receive a reduced allowance merely because reconciliation occurred after period start. Initial and continuing Full periods now receive the full 6,000 seconds. A genuine lower-plan upgrade receives one immutable prorated grant; repeated snapshots cannot replenish it.
3. An expired allowance could appear as current available minutes. The shared UI type now requires `usage.periodState`, and the loader marks an expired commercial period as ended.
4. A missing-period snapshot could erase the last verified billing boundary, allowing a subsequent overlapping period to bypass the grant guard. Missing dates now preserve both last-known boundaries, while the source comparison prevents admission. The regression covers verified period A → missing period → overlapping period B.

Access checks reviewed: rollout starts disabled with no customer list entries; owner updates use fresh workspace authorization and repeat ownership/revision checks in SQL; paid voice requires the canonical active Full subscription and current period; customer time is separate from provider usage and SMS accounting; new RPCs are service-only; allowed owner reads remain tenant-scoped.

## Deletion review

The first pass found two lock inversions: a late start/end update versus deletion of terminated but unsettled call history, and a customer-favorable adjustment's audit insert versus account deletion. The schema author changed metering to lock business before period, usage, and session. Commercial session deletion now waits for completed settlement, after which metering retries return before updating the session. Immediate account PII scrubbing remains; final history purge can wait for the existing reconciliation window.

The second source pass confirms the new lock order, immutable settled deductions, retained call-identity deduplication, and one-way clearing of business/session references. The added concurrency test deliberately holds a history row while late end evidence tries to settle, verifies that unsettled deletion fails promptly, then verifies deletion after settlement preserves usage. No additional deletion or source-identity blocker remains in this source pass. Schema-author database and concurrency results are recorded separately; final clearance still depends on those targeted checks and any subsequent schema delta.

The fallback-only edit issue is resolved consistently in the UI, server precheck, and locked SQL update. Current enablement is required for a text-to-voice transition; retaining an existing voice selection while editing fallback cannot bypass the separate call-admission checks. Ownership and expected-revision checks still apply to every edit. No remaining source-review blocker was found in this final delta.

## Remaining release checks

The owner UI still requires desktop/mobile browser verification. Full-worktree tests, isolated database concurrency checks, application/worker builds, closed-gate deployment verification, and the approved private-pilot phone test remain root-owned release checks. No claim about real speech quality, invoice reconciliation, commercial margin, or customer rollout follows from this review.
