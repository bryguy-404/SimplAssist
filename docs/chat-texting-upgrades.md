# Add texting to an existing Chat Only account

This release adds `/billing/add-texting` without reopening signup. Additive migration `091_chat_texting_upgrades.sql` and the verified cleanup fix in `092_voice_accounting_cleanup.sql` were applied to the linked SimplAssist production database on September 23, 2026. See the [production schema verification](./chat-texting-upgrades-production-schema-2026-09-23.md). **Application/worker deployment, scheduler creation, and enablement remain separate release actions.** The schema release did not change production application configuration or enable upgrades.

## Customer behavior

Choose Starter ($25/month), Growth ($45/month), or Pro ($65/month); confirm saved business details; complete EIN/legal verification, texting use case/consent/risk review, and phone selection; review the exact quote; explicitly confirm payment; wait for carrier review and number assignment.

Selection and saved forms do not create Stripe customers, subscriptions, payable invoices, or Telnyx resources. Number search reads inventory; choosing a number saves a preference. The customer keeps the same Stripe customer/subscription and renewal date. The payment step uses a pending subscription update with immediate proration and the existing $25 setup fee. A failed payment retains the original subscription; an open invoice has a hosted recovery link.

After verified payment, billed plan and fee fulfillment move atomically to the chosen tier, while available services stay Chat Only (including the existing 200-reply allowance). Usage and in-flight reservations do not reset. A normal paid renewal starts the next Chat allowance period. Activation requires current eligible billing, approved brand/campaign, one active owned number, and assignment to the exact current campaign. Once activated, later carrier outages cannot restore the temporary Chat allowance.

Starter requires explicit acknowledgement that website chat, AI customization, and calendar/booking features end at activation. Saved conversations and configuration remain. Growth/Pro gain their normal capabilities at activation. Pro's paid voice allowance uses existing exactly-once billing accounting; activation never grants another allowance.

Drafts can change plans or be abandoned without deleting saved forms. An uncertain payment must recover its original operation. A confirmed unpaid invoice must be conclusively void before replacement. Paid targets are frozen; rejection uses existing support correction/retry and refund policies. Normal subscription cancellation remains available; cancellation requests stop new registration/activation while ordinary access lasts through the existing paid period.

## Boundaries and recovery

- `chat_texting_upgrades` is service-controlled, owner/source bound, and permits only one non-abandoned flow per business. Draft progress never writes the original onboarding completion or step.
- Quote creation rechecks actual prerequisites and captures a database fingerprint before the read-only risk/setup loader. Acquisition and confirmation compare it under the business lock. Changes require a refreshed review.
- Billing uses the existing `sms_billing_operations` ledger with dedicated Chat-upgrade acquisition/confirmation/finalization. Ordinary checkout and SMS plan-change endpoints cannot perform this transition.
- The setup-fee invoice line carries both upgrade and operation IDs. Recovery verifies the exact invoice, customer, subscription, fee price/quantity/amount, quoted total, and target proration period. It never substitutes a later renewal invoice. Missing response recovery searches for the immutable operation marker; unresolved work cannot be replaced after Stripe's idempotency retention window.
- `get_business_effective_service_plan` governs runtime TypeScript and SQL enforcement for widgets, AI metering, SMS, voice, website scans, and calendar/booking creation. Provisioning uses verified billed authority instead of the temporary service plan.
- Retained Chat checkout metadata and historical usage are evidence, not permission to restore old billing. Application dispatch and database projection guards enforce the explicit transition.
- Reconciliation runs after payment/subscription events, carrier assignment/status processing, explicit customer refresh, and the periodic endpoint. State GET performs no provider mutations. The existing registration claims, provider-create intents, owned-number recovery, and rejection checks remain in use.
- Customer edits freeze when payment starts. The carrier's generated sample/opt-in copy has a separate, narrow, service-only guarded persistence operation.

Authenticated endpoints below `/api/billing/texting-upgrade` are GET state, POST select/save, and POST `/quote`, `/confirm`, `/cancel`, `/refresh`. Business and owner are resolved from fresh workspace authorization, never supplied by the request body. `/reconcile` uses scheduler bearer authentication instead of customer authorization.

## Support after carrier rejection

A carrier rejection places the paid upgrade in `support_required`; customer refresh and scheduled reconciliation cannot resume provider work. Staff must resolve the rejection through the existing support process and verify approval of the account's existing brand and campaign. This release does not automatically replace rejected resources or collect another setup fee.

After the existing brand and campaign are approved, use **Recheck assignment** in the account's admin SMS compliance card. The authenticated admin request records an audit event and resumes the held upgrade in one database transaction. It requires the original paid subscription/customer, the selected billed tier, an active current paid period with no cancellation request, enabled account operations, the existing approved brand/campaign/profile, and exactly one active provider-owned number. Ineligible or ambiguous accounts remain blocked.

The recheck can inspect or assign that existing number to the current approved campaign. An already assigned number can complete activation without a new assignment. It does not create or replace a brand, campaign, profile, or number. The normal atomic activation checks run afterward; Chat remains available until those checks pass. If billing is canceled, a resource is missing, or the carrier correction requires replacement, keep the account in support and follow the existing manual support/refund policy. Never clear payment evidence, reset onboarding, or edit the upgrade state directly to bypass these checks.

## Controlled release

1. Keep `CHAT_TEXTING_UPGRADES_ENABLED` unset or `0`, and `CHAT_TEXTING_UPGRADE_CANARY_BUSINESS_ID` unset. Apply migrations 091 and 092, in order, using the normal reviewed migration process. Migration 092 fixes the pre-existing hard-deletion conflict between voice history and retained anonymous usage; it preserves the existing accounting and unresolved-usage protections. Do not reset or rewrite existing migrations.
2. Deploy the complete transition-aware application and every worker that imports billing/access/runtime code. Drain old web and worker instances before any paid conversion. Verify private table/RPC privileges and existing signup/Chat/SMS/partner paths.
3. Verify the configured live Stripe Prices are the existing $10/$25/$45/$65 monthly products and one-time $25 fee, on the same Stripe account/mode as the webhook. Verify the configured Billing Portal permits payment-method management and invoice history but **does not permit subscription plan updates** that bypass this workflow. Preserve the current support-assisted cancellation policy and disabled Portal cancellation; do not enable automatic resource release as part of this launch. Support-requested Stripe cancellation is honored by the upgrade's billing, provisioning, activation, and access checks.
4. Confirm webhook delivery for `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.pending_update_applied`, `customer.subscription.pending_update_expired`, `invoice.payment_succeeded`, and `invoice.payment_failed`. Keep signed-event provenance and retry handling enabled. Pending-update events must be added if absent from the existing endpoint.
5. Create a separate cron-job.org job named **SimplAssist Texting Upgrade Reconciliation**: POST `https://simplassist.com/api/billing/texting-upgrade/reconcile`, every five minutes, header `Authorization: Bearer <CRON_SECRET>`, timeout 30 seconds. Store the secret in the scheduler's protected configuration. Do not include it in the URL. This does not replace or modify Account Cleanup. The endpoint leases up to 3 records, has a 20-second request budget, returns 202 for deferred work and 503 for failures, and remains enabled when acquisition is disabled. Durable operations allow safe retries after timeout.
6. Set only `CHAT_TEXTING_UPGRADE_CANARY_BUSINESS_ID` to a reviewed eligible canary UUID. Verify resume, each target's review, cancellation/recovery, Chat continuity and the 200-reply meter, exact carrier/number activation, Starter cutoff, and normal renewals. Use Stripe test mode and provider fixtures for payment failure experiments; never deliberately decline or fabricate carrier approval in production.
7. After review, set `CHAT_TEXTING_UPGRADES_ENABLED=1` for general availability; remove the canary variable if no longer needed. Only the exact value `1` enables broad acquisition. Monitor payment_pending age, carrier/support states, scheduler failures, webhook retries, and provider-create recovery.

## Rollback

Disabling the broad flag and clearing the canary blocks new flows and first confirmations, while existing confirmed payment/carrier recovery continues. Existing drafts remain readable/editable/cancelable.

**After the first paid conversion, the preceding production application is not a safe rollback target.** Keep a verified release containing migration 091-compatible billing synchronization, effective-service enforcement, and recovery. Roll back only to that compatible release and drain incompatible workers. Do not roll back the schema, erase upgrade records, or unlock/revert the paid family. Preserve Chat sales configuration during a UI rollback. Any paid reversal or SMS-to-Chat conversion remains support-assisted and outside this release.

## Verification

Automated coverage is split across payment/state/forms/route/UI tests and migration 091 database integration tests. The provider verification performed in isolated Stripe test mode created disposable customers, subscriptions, clocks, and Prices; it checked all three successful targets, declines, authentication-required invoices, idempotent replay, and an intervening renewal. Customers/clocks were deleted and temporary Prices/product archived after the checks.

Browser checks use the real new components with controlled API fixtures, including resume/navigation and Starter acknowledgement. They do not establish live carrier approval or replace the restricted release canary. See [the verification report](./chat-texting-upgrades-verification-2026-09-23.md) for final check results and scope.
