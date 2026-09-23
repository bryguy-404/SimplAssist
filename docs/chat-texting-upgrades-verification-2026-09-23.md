# Chat Only to texting — verification, September 23, 2026

Implementation is complete in the working tree. Production migrations 091 and 092 were applied to SimplAssist on September 23, 2026; see the separate [production schema verification](./chat-texting-upgrades-production-schema-2026-09-23.md). Application/worker deployment, webhook configuration, scheduler, and enablement have not been changed. New upgrades default to disabled. Follow the [controlled release and rollback procedure](./chat-texting-upgrades.md) before enabling any account.

## Application checks

| Check | Result |
| --- | --- |
| Full Vitest suite | 432 files, 7,335 tests passed |
| TypeScript (`tsc --noEmit`) | Passed |
| ESLint (`npm run lint`) | Passed without warnings |
| Production build (`npm run build`) | Passed |
| `git diff --check` | Passed |

The full suite used `vitest run --exclude '.worktrees/**' --exclude '.claude/**'` so unrelated pre-existing local worktrees were not collected. Local networking was enabled for the existing voice-worker WebSocket tests. Focused tests also ran throughout implementation.

Coverage includes all three target plans, missing prerequisites, owner authorization, side-effect-free selection and draft saves, resumable forms, renewed quotes, Starter consent, payment declines and customer authentication, lost responses, operation reuse, exact invoice recovery across renewal, old Chat event replays, pending-service entitlements, metering, phone ownership, provider recovery, rejection, cancellation, scheduler leases, and admin-assisted recovery.

## Database checks

Database integration and concurrency checks were run in an isolated schema-only scratch database in the verified local PostgreSQL container. These automated tests did not use, reset, or migrate a hosted Supabase database. Connection targets in older concurrency fixtures were redirected in memory to the scratch database; production SQL and assertions were preserved.

The final focused database run after migration 092 passed **27 files and 1,234 assertions**, with no failed files. This includes 74 upgrade integration cases, 20 upgrade concurrency assertions, 22 new cleanup assertions, and 10 new cleanup concurrency assertions. Related suites cover Stripe deletion actions, cancellation/resource lifecycle, existing voice allowances and admission, billing guards, metering, admin recovery, and retained Chat behavior. This is the scoped release regression suite, not every database test in the repository.

The previously failing `085_public_voice_concurrency.test.sql` now passes all five assertions. Its failure was reproduced before the fix: hard business deletion followed overlapping business/session foreign-key paths and could check a stale session reference. Migration 092 first locks the associated call history, rejects any unsettled usage, and detaches only the business/session links on settled usage before cascading deletion. Anonymous amounts, allowance grants, payment evidence, call-replay protection, and immediate foreign keys remain intact. Normal customer cleanup continues using its existing tombstone flow.

The concurrency checks verify both orders of competing history/account deletion, preserving the same settled usage without lock inversion. They also retain the existing voice test for an unsettled history deletion racing a late settlement. Upgrade races verify one paid operation/voice grant, confirmation versus quote refresh, nonoverlapping scheduler claims, cancellation versus activation, and duplicate activation.

Local evidence: `/private/tmp/cleanup-step1-db-suite.log`, `/private/tmp/cleanup-step1-db-summary.json`, and individual `/private/tmp/cleanup-step1-*.test.sql.log` files. The prior failure is retained in `/private/tmp/cleanup-step1-baseline085.log`. Both disposable databases used during verification were dropped and verified absent; the automated test phase left original local databases and production untouched. The later authorized production schema release is documented separately.

Migrations 091 and 092 are apply-once, consistent with the existing migration system. Retry safety is implemented and tested in the payment, reconciliation, and activation operations; it does not require replaying migrations. Application code did not change during the cleanup fix, so the earlier TypeScript, lint, build, and full application-suite results still apply.

The scratch database cannot load the container's `pg_cron` extension, which is bound to its primary database. Existing scheduler-policy assertions used a read-only copy of that container's local `cron.job` metadata. Deterministic seed rows omitted by the schema-only dump were restored from checked-in migrations, including the disabled Telnyx-release control and protection manifest. This does not verify a production scheduler or create any scheduled jobs.

## Stripe provider checks

Real Stripe calls used only a key positively identified as test mode, disposable customers, test clocks, subscriptions, and temporary Prices. The test subscription began on Chat Only, then advanced halfway through its period. Each successful scenario retained the same customer, subscription, and renewal anchor, and verified a single operation-bound $25 setup-fee line plus the prorated price difference.

| Scenario | Result |
| --- | --- |
| Starter | Passed; $32.50 due in the controlled half-period fixture |
| Growth | Passed; $42.50 due in the controlled half-period fixture |
| Pro | Passed; $52.50 due in the controlled half-period fixture |
| Repeated subscription update | Same idempotency key reused the original invoice |
| Payment recovery after intervening renewal | Original upgrade invoice remained verifiable even after `latest_invoice` changed |
| Declined payment | Original Chat subscription remained; open hosted invoice recovered; verified void removed the pending update |
| Authentication required | Original Chat subscription remained with an open hosted recovery invoice |

These amounts are fixture results, not fixed customer upgrade prices. The application previews and revalidates each customer's actual amount. The integration follows Stripe's [pending-update contract](https://docs.stripe.com/billing/subscriptions/pending-updates).

All five test clocks and their associated customers were deleted. Five temporary Prices and the temporary product were archived. No live-mode Stripe charge or Telnyx resource was created. The local provider report is `/private/tmp/simplassist-texting-upgrade-verification/stripe-provider-report.json`.

## Browser checks

The real React components and shared forms ran in a local browser harness with controlled API responses. Checks covered Starter/Growth/Pro choices without a default, prefilled business details, EIN and representative details, texting use case and consent, phone search/selection, review Edit links, quoted charges, fresh Starter acknowledgement, carrier-pending status, reload/resume, and Starter activation. Desktop and 390-pixel mobile layouts loaded without horizontal overflow or an error overlay.

Screenshots are in `/private/tmp/texting-upgrade-ui/`: `plan-desktop.png`, `review-mobile.png`, `carrier-pending-mobile.png`, and `activated-mobile.png`. The browser and harness were stopped after verification. Subsequent wording and admin-recovery changes were covered by component tests, TypeScript, lint, and the production build.

This was a component-level browser check with mocked APIs. It did not exercise real authentication, the deployed API/database connection, a hosted Stripe authentication challenge, or live carrier approval. Carrier callbacks and resource-recovery failures used controlled automated fixtures. The restricted release canary must verify the deployed account flow and real carrier readiness.

## Release status

At 18:53:03 UTC on September 23, 2026, a read-only Railway check confirmed both `CHAT_TEXTING_UPGRADES_ENABLED` and `CHAT_TEXTING_UPGRADE_CANARY_BUSINESS_ID` were unset in the SimplAssist production environment for the web application, `simplassist-scan-worker`, and `simplassist-voice-worker`. Both upgrade rollout paths therefore default to disabled. No variables or deployments were changed by this check.

Migrations 091 and 092 are now applied in production. Migration 091 provides the shared service-policy functions; 092 resolves the cleanup issue found during verification. Next, deploy all compatible web and worker readers with acquisition disabled, drain older instances, verify Stripe event delivery and the separate five-minute reconciliation job, then enable only an eligible canary. General availability is a separate reviewed step.

After the first paid conversion, rollback requires a compatibility release that understands the upgrade ledger and preserves billing, temporary Chat service, and carrier recovery. Do not revert the schema or erase upgrade/payment history.
