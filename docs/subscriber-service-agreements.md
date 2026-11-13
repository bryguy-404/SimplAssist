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
- No production migration, live payment, email, or production backup configuration was performed during verification.
