# Full Suite public voice: database verification

September 17, 2026. Scope: migrations 084–086, public access, payment-bound enrollment, pilot retirement, capacity, and disclosure integration. Production activation remains a separate release step.

## Verified result

- Final complete SQL suite: **75 files, 3,296 assertions passed**.
- Public access TypeScript suite: **29 tests passed**.
- A guarded fresh replay of all migrations succeeded on the disposable `SimplAssistVoice` project using Supabase CLI 2.115.0 and ports 55321/55322. The final migration files match that replay byte for byte. Two subsequent fixture corrections passed the complete suite without a reset.
- Four-business admission and a competing fifth call were exercised concurrently. Exactly four calls reserve minutes; the fifth retains its selected fallback policy. Two calls remain the limit per business across pilot and commercial sources.
- No production schema or data mutation was performed for these checks.

Temporary logs: `/private/tmp/full-suite-db-fourth.log` records the successful migration replay; `/private/tmp/full-suite-db-final.log` records the complete passing suite.

## Payment and allowance invariants

The verified billing-operation finalizer enrolls voice within the transaction that updates the canonical subscription. It supplies the prior tier and period before replacement. A new paid Full month receives 6,000 seconds; an upgrade receives the proportional remaining allowance using the original verified payment time. Replays and same-period paid re-upgrades cannot refill consumed minutes.

Recurring subscription retrieval does not constitute invoice payment proof. A new period requires immutable invoice evidence for the exact customer, subscription, and monthly interval. Canonical source checks and reconciliation revisions reject an old source after an authorized replacement. Old paid operations cannot replace newer authority.

The operation ledger survives the privacy scrub until actual account-cleanup completion verifies cancellation. The existing tombstone workflow then clears owner-linked billing authority atomically. Minimal payment deduplication and settled usage remain immutable; hard deletion clears their business links and cannot refund usage.

## Public access and pilot transition

Public eligibility no longer depends on a manually populated business list. It requires the current verified paid Full authority, available monthly allowance, operational access, and global rollout. The former list serves only as optional emergency overrides. New customers default to Text.

Bryan’s normal confirmed paid Full upgrade permanently retires the private tester exception, preserves the selected Voice preference, and keeps prior calls on their original pilot lifetime pool. Already admitted calls may drain. Downgrades cannot restore private admission, private prewarming, or the prior-disclosure shortcut. Retired pilot account cleanup retains the permanent marker on its anonymized tombstone.

Admission holds the global capacity lock before business, preferences, and allowance reservation. Paid transition, private pilot controls, and pilot finalization use business-first ordering. Closed calls without actual phone-termination proof continue to occupy capacity; a WebSocket disconnect or accepted hangup command is insufficient.

Commercial booking permission requires the current business goal, selected booking mode, active booking entitlement, operational permissions, and its own connected calendar for direct booking. The existing confirmed-action executor separately revalidates current authority immediately before calendar submission.

## Disclosure and runtime boundary

The public protocol authenticates an unrecorded notice phase. A complete audible notice and its matching current playback acknowledgment precede recording. Only the acknowledged post-notice handoff activates conversation storage, business actions, and the customer clock. A proven terminated notice-only call settles at zero; an uncertain active conversation retains its existing recovery hold.

The one-call approved-tester rehearsal uses the same public opening without fabricating a commercial subscription or moving the pilot budget to monthly accounting. It is service-armed, expires, and is consumed atomically.

## Independent production baseline

A read-only transaction against project `inmgpkurctttsofpywuz` verified:

- Migrations 084–086 and their new tables/columns were absent.
- Recorded 081–083 SQL hashes matched the canonical files. Their function, table, constraint, index, trigger, and access-control catalog matched the prior independently verified production snapshot.
- Rollout was disabled, stored fleet capacity was two, and commercial settings, projections, allowances, and usage were empty.
- The pilot settings, approved testers, and subscription fingerprints were unchanged. Fourteen calls remained pilot history; no call was active.

The baseline is preserved locally in `/private/tmp/full-suite-independent-baseline-report.json` for comparison after application. Migration 085 permits a configured capacity of four but leaves the stored value at two. Public rollout and commercial sales remain closed until the separate release checks pass.

## Independent production verification after migration

A separate read-only session verified production after the root applied the atomic 084–086 bundle, before application deployment. **All checks passed.**

- Canonical migration-text hashes match for 081–086.
- The tested local catalog matches production exactly: 81 functions, 13 tables, 180 columns, 82 constraints, 29 indexes, 12 triggers, four policies, function grants/security settings, table permissions, and the pilot totals view.
- Pilot settings, testers, subscriptions, prior call accounting, provider usage, SMS usage, and Leads fingerprints are unchanged.
- Rollout remains disabled at capacity two. No commercial grant, usage, setting, operation, payment proof, pilot retirement, or rehearsal arm was created.
- Migration 084 copied exactly two existing customer/setup-fee identity records. Their business, customer, and setup timestamps exactly match existing subscriptions; this did not create a purchase or voice allowance.
- All fourteen historical sessions retain protocol zero and pilot accounting. No voice call was active.

Production catalog SHA-256: `3a2cc3c54743eb9503f4f3fcef9d768ffa9244a3c2c68482008b8a260edb167c`.

The complete machine-readable comparison is `/private/tmp/full-suite-independent-after-report.json`; the independently captured production catalog is `/private/tmp/full-suite-independent-production-catalog.json`. Verification used only explicit read-only transactions on project `inmgpkurctttsofpywuz`.
