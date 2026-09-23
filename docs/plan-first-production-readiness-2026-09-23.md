# Plan-first onboarding: production readiness check

Checked September 23, 2026, against the existing SimplAssist production web
service. This was a read-only pre-deployment check. No application deployment,
migration, production checkout, customer creation, or provider provisioning was
performed.

## Database: ready, no migration required

The production Supabase project is `inmgpkurctttsofpywuz`, matching the production
Railway service configuration. Its migration ledger contains all 90 repository
migrations, `001` through `090`, with no missing or unexpected versions.

Metadata-only queries inside read-only transactions confirmed the existing
saved-plan and provider-history columns, plus all 14 checked onboarding,
checkout-recovery, SMS billing, and voice billing function signatures. Every
checked function is executable by the service role. In particular,
`begin_voice_billing_reconciliation` and `record_voice_billing_payment` are
present; the outdated local database encountered during testing does not
describe production.

The authenticated database API also exposes the expected tables and functions.
No customer rows were queried or changed.

## Deployment and payment configuration

- Railway project: `SimplAssist`, production environment.
- Web service: `a0147f69-17f1-484a-a02d-e60e73b7c1d4`.
- Current web deployment: `fe7bd3b7-cc50-40c0-9864-a54b9820f978`, successful and
  running, created September 20. Its deployment description identifies main
  `e44e790`. This is the application rollback target for the new release;
  Railway reports it can be redeployed.
- The scan and voice workers also report successful, running deployments.
- Application URL: `https://simplassist.com`.
- Chat Only direct sales are enabled; no canary is set. Partner Chat assignment
  remains disabled. No sales configuration was changed.
- The server Stripe key is live. All six configured prices are distinct, live,
  active, USD, and attached to active products. Monthly prices match Chat Only
  $10, Starter $25, Growth $45, and Pro $65. The existing SMS setup price is $25
  and SMS overage price is $0.03.
- The live webhook destination `https://simplassist.com/api/stripe/webhook` is
  enabled. Checkout completion/expiration, subscription creation/update/deletion,
  and invoice payment success/failure are subscribed. A signing secret is
  configured; this check does not prove hosted delivery or secret matching.

## Existing observations to keep separate from the onboarding change

- The configured browser publishable Stripe key is test-mode, although the
  server key is live. Repository search found no application use of the
  publishable key or Stripe.js; current checkout redirects to the server-created
  Stripe Checkout URL. Align or remove this unused setting before introducing
  a browser Stripe integration.
- The webhook subscription omits `customer.subscription.pending_update_applied`
  and `customer.subscription.pending_update_expired`, which the application
  handles for existing subscription changes. Initial onboarding checkout does
  not use pending subscription updates, and payment-success events plus Billing
  status refresh already provide recovery for paid upgrades. Add these existing handlers' events to
  the webhook configuration as a billing configuration follow-up; no webhook
  settings were changed during this check. The expired-event handler alone does
  not guarantee immediate local operation expiry; Billing status refresh
  explicitly recognizes a void/uncollectible invoice and expires the operation.
  See [Stripe's pending-update lifecycle](https://docs.stripe.com/billing/subscriptions/pending-updates).
- Public signup works at `https://simplassist.com/signup`. The `www` hostname
  instead shows the existing invitation-only message because public signup
  requires the exact canonical host. Share the canonical signup URL; a
  `www`-to-canonical redirect is a separate improvement.
- `/api/health` returns 200, but its Next.js-cached timestamp is from the current
  build. It proves a response is being served, not fresh database or payment
  health. The schema and Stripe checks above were performed directly.

## Verification scope and release steps

The earlier candidate verification passed 7,119 tests across 420 files,
TypeScript, lint, production build, local browser navigation, and one disposable
Stripe test payment with canceled-checkout reuse and lost-return recovery.
See [implementation verification](plan-first-onboarding.md#implementation-verification)
for the fixture and webhook replay limitations.

Live HTTP reads found the homepage, signup, login, onboarding shell, and health
paths responding on both public hostnames. Public HTML was private/no-store and
showed no obvious server error page. Authenticated production onboarding and a
live payment were not exercised. The new onboarding code remains local and has
not been deployed.

The checked schema and initial-checkout configuration support deploying the
candidate without a migration or new environment variable. Package and review
the complete application change, deploy it, then verify the authenticated
Chat Only and texting paths in the hosted release. Keep payment scenarios in
isolated Stripe test mode unless a live transaction is separately authorized.
Rollback restores the preceding application deployment while preserving saved
plans, checkout locks, account data, and Chat Only sales settings.
