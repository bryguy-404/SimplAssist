# Subscriber service agreements

The unchecked service agreement appears immediately before new checkout and paid upgrade confirmation, for every plan including discounted/$0 checkout. The server requires the authenticated owner’s current version before payable work. SMS/recording consent remains separate. No agreement emails are sent.

Apply `121_subscriber_service_agreements.sql` before releasing the application. A missing/unavailable evidence store stops new payment attempts; it does not block renewals, cancellations, or paid onboarding completion. Existing subscribers can accept in Settings/Billing without repurchasing. No historical SMS consent or payment timestamp is converted into a Terms acceptance.

`service_terms_versions` contains the full accepted HTML, hash, exact checkbox wording, and document links. `service_agreements` captures the owner and business snapshot, version, server submission timestamp, and entry point. `service_agreement_references` adds payment/operation references without modifying the original evidence. All three tables prohibit application updates/deletes, are inaccessible to anonymous/customer database clients, and are read through authenticated owner/admin routes. Acceptance is reused for the same owner, business, and current version. Older versions and acceptances remain retained independently of subscription/account foreign-key deletion.

Customers open `/settings/billing/agreements` from Settings, Billing, or the onboarding account controls. This page is outside the subscription-gated dashboard layout and remains usable after cancellation. The admin business page shows the same history. View/download responses contain the historical Terms and acceptance details, are uncached, and escape customer content. Downloaded HTML is standalone and can also be printed to PDF. Account deletion and any legally required evidence retention/purge policy are separate from subscription cancellation.

## Backups and release checks

Include all three tables in the database backup/restore policy. Verify the production backup schedule and retention before launch; this code change does not configure the hosting provider’s backup schedule. For an additional private copy, run `node scripts/export-service-agreements.mjs /private/backup/location/agreements-TIMESTAMP.json` with Supabase credentials supplied through the environment. The script exports every retained version and record, validates archived document hashes, uses owner-only file permissions, and refuses to overwrite a prior export. Never commit or publish these exports. A full database backup is preferable for consistent recovery; if the export reports missing versions or referenced acceptances while new records are being written, rerun it.

Restore database backups into an isolated database first, then check the document hashes and business/version links before restoring production. The JSON export can recover these tables in order: versions, agreements, references, preserving the saved timestamps and IDs through a privileged restore connection. Test a customer and admin download against the restored archive. Do not re-date acceptance, fill missing records from SMS flags, or represent email delivery/signature evidence that was never collected.

The archive test compares every visible Terms section with the public Terms page for both pricing variants. When Terms wording changes, add a new preserved version and update the current document selector together. Never edit a previously stored document. Existing paid access and recurring renewals are not made conditional on accepting a new version.

## Implementation verification

- The production build, lint, and TypeScript checks passed.
- 740 focused agreement, billing, Stripe operation, and affected UI/API checks passed.
- All 16 local database assertions passed, including immutable history, authenticated identity, server timestamps, and retry reuse.
- A synthetic local account with a canceled subscription saved an acceptance through the browser. Customer and admin downloads returned identical historical copies; an anonymous request was refused. Retrying acceptance preserved its original timestamp, and a private backup export validated the archived hash.
- The wider suite passed 8,681 checks with four failures in existing website-copy/sitemap expectations. The same four failures were reproduced from a separate clean copy of commit `73a0644a7990141f0d3364cfa1052f3fde608360`.
- No production migration, live payment, email, or production backup configuration was performed during the pre-release verification above.

## Production release — 2026-11-13

- Release source: `6fd4c17df2d5acb37ebbe855f50a97906cb6bf68`, including the agreement feature in `2d971b9b41863594f5774c70103773ba84249be4`. Published from a clean Git archive, excluding unrelated working-tree edits and local credentials.
- Railway production web deployment: `39e9c398-e8cb-42a7-885a-7eabc392324c` reached `SUCCESS`. The prior application rollback target is `8ce71325-2d19-4eb8-a8c2-dbc5c6bfde9c`; the additive agreement tables can remain in place during an application rollback.
- Verified seven completed daily physical database backups (November 6–12) before applying migration 121. The newest observed backup was `2242973659`, completed at `2026-11-12T08:08:52.888Z`. Point-in-time recovery was not enabled. This was a backup-status check, not a restore rehearsal or a change to retention settings.
- Applied migration 121 only. Verified all three tables have RLS, anonymous/customer direct reads are denied, service-role update/delete privileges are absent, the three immutability triggers are enabled, and only the service role can execute the owner-validating acceptance function.
- Live checkout rejected missing acceptance on all four plans before payment work, and rejected a stale Terms version. Onboarding showed the exact approved wording unchecked above the disabled payment button.
- Customer and admin browser history/preview checks passed. Their downloaded files were byte-for-byte identical and included the complete archived Terms and unmodified subscriber details. Acceptance retries preserved the original record and timestamp; anonymous access and customer access to the admin route were refused. A private export validated the archived hash and record links.
- Existing subscription, billing-operation, phone-number, and account-authority fingerprints matched the pre-release baseline. Application configuration and all four worker deployments were unchanged; the voice service remained ready.
- Health, signup, Terms, and Privacy endpoints returned HTTP 200. The checked deployment log window had no HTTP 5xx responses or application errors; its only error-level entry was npm's existing production-option warning.
- A clearly labeled synthetic release account was used; no real customer account, subscription, phone provisioning, card charge, or message was involved. Its immutable acceptance is retained as test evidence, not represented as a real customer's agreement. No agreement email workflow was added.
- The synthetic account's operations and login were disabled after verification, and temporary test credentials were removed. Production checks deliberately did not execute a successful Stripe charge; payment success/recovery, cancellation, and renewal behavior are covered by the pre-release regression checks above.

Live verification found that CDN email obfuscation was rewriting addresses inside the downloaded HTML. Agreement view/download responses now include `Cache-Control: private, no-store, no-transform`, keeping the saved Terms and subscriber details intact through delivery. This is scoped to authenticated agreement responses, not a site-wide security-setting change. See [Cloudflare's documented no-transform exception](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/). The 23 agreement tests passed after this correction.
