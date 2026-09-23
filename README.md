SimplAssist is a [Next.js](https://nextjs.org) application deployed on Railway.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Railway Environment

Phase 8 A2P screening uses these deployment variables:

- `FIRECRAWL_API_KEY` - optional website scanner key. If missing or unavailable, the app falls back to a safe direct website fetch.
- `RICHER_WEBSITE_SCAN_ENABLED` - server-only exact-`1` production rollout switch for the review-first multi-page scanner. Leave unset or `0` until its canary passes.
- `RICHER_WEBSITE_SCAN_CANARY_BUSINESS_ID` - optional server-only canonical business UUID for one richer-scan canary while the broad switch remains off. Never create a `NEXT_PUBLIC_` copy.
- `A2P_REVIEW_EMAIL` - comma-separated support recipients for manual A2P review alerts. Falls back to `SUPPORT_EMAIL`, then `support@simplassist.com`.
- `A2P_REVIEW_ADMIN_TOKEN` - bearer token required for the manual A2P review override endpoint.

Phase 9 billing/admin and Phase 3 calendar/operations use these deployment variables:

- `NEXT_PUBLIC_APP_URL` - canonical public HTTP(S) origin for SimplAssist. Production Stripe redirects, Telnyx webhooks, Google OAuth, branding, and public URLs must all resolve to this exact origin.
- `STRIPE_SECRET_KEY` - Stripe secret key for the deployment's fixed account and mode. Production uses its existing `sk_live_...` key. Never switch the production application to a test key, even temporarily, or mix test and live Stripe objects in the production database.
- `STRIPE_WEBHOOK_SECRET` - signing secret for `/api/stripe/webhook` from the endpoint in the same Stripe account and mode as `STRIPE_SECRET_KEY`. Production uses the live endpoint secret.
- `STRIPE_PRICE_SMS_ONLY` - recurring Price ID for Starter / SMS Only in the same Stripe account and mode as the secret key; production uses the live Price.
- `STRIPE_PRICE_SMS_AND_CHAT` - recurring Price ID for Growth / SMS + Web Chat in the same Stripe account and mode as the secret key; production uses the live Price.
- `STRIPE_PRICE_FULL` - recurring Price ID for Pro / Full Suite in the same Stripe account and mode as the secret key; production uses the live Price.
- `STRIPE_PRICE_CHAT_ONLY` - server-only recurring Price ID for Chat Only in the same Stripe account and mode as the secret key. Before exact-business acquisition, verify that it is an active, licensed/non-metered USD Price for exactly $10 every month and distinct from every SMS base, setup-fee, and overage Price. Phase 4 configured the production-live Price without creating a Chat Only Checkout or charge. Keep this value configured even while acquisition is disabled so the Phase 7 owner-led acceptance, signed webhooks, and historical plan recovery use one stable Price.
- `STRIPE_PRICE_SETUP_FEE` - one-time Price ID for the $25 setup and SMS activation fee in the same Stripe account and mode; production uses the live Price.
- `STRIPE_PRICE_SMS_OVERAGE_PART` - Price ID for $0.03 per extra SMS part after opt-in in the same Stripe account and mode; production uses the live Price.
- `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` - server-only ID of the reviewed Stripe Billing Portal configuration (`bpc_...`) for this Stripe account and mode. Portal session creation fails closed when this pin is missing or malformed; never expose it through a `NEXT_PUBLIC_` variable.
- `CHAT_ONLY_DIRECT_SALES_ENABLED` - server-only, exact-`1` rollout switch reserved for the monitored public direct Chat Only launch after the Phase 7 owner-led live acceptance passes. Leave unset or `0` throughout Phases 5 and 6 and during the exact-business portion of Phase 7.
- `CHAT_ONLY_DIRECT_CANARY_BUSINESS_ID` - optional server-only exact canonical business UUID for the isolated direct Chat Only acceptance while the broad flag remains off. In production, setting it with the live Chat Price authorizes that exact eligible business to begin a real-charge Checkout, so configure it only for the separately approved Phase 7 window and remove it after the exact-account evidence is complete. It accepts no list, whitespace, wildcard, or public/browser variant. Never create a `NEXT_PUBLIC_` copy.
- `CHAT_ONLY_PARTNER_ASSIGNMENT_ENABLED` - independent server-only, exact-`1` rollout switch reserved for new partner-admin chat-only assignments. Leave unset or `0` until partner acceptance testing is complete.
- `WIDGET_TOKEN_SECRET` - server-only secret used to sign short-lived public widget sessions and derive opaque traffic keys. Use at least 32 cryptographically random bytes, keep it identical across all application instances, and never expose it through a `NEXT_PUBLIC_` variable. Rotation immediately invalidates existing five-minute widget sessions and changes the traffic-key namespace, effectively starting new rate buckets; rotate deliberately across every instance at once.
- `WIDGET_EDGE_ORIGIN_SECRET` - distinct server-only proof that a public widget API request traversed the reviewed Cloudflare edge before Railway. Use 43–128 base64url-safe characters derived from at least 32 cryptographically random bytes (64 lowercase hexadecimal characters is valid), keep it identical to the value Cloudflare overwrites into `x-simplassist-widget-edge-origin` on the five exact public widget API paths, never reuse `WIDGET_TOKEN_SECRET`, and never create a `NEXT_PUBLIC_` copy. Public embed API calls use the canonical application origin; authenticated dashboard preview remains same-origin.
- `WIDGET_PROACTIVE_INVITATIONS_ENABLED` - server-only, exact-`1` global switch for delivering proactive chat invitations to public widgets. Leave unset or `0` to suppress automatic opening without changing any owner's saved preference; authenticated previews may still show the saved preference. Never create a `NEXT_PUBLIC_` copy.
- `WIDGET_PROACTIVE_INVITATIONS_CANARY_BUSINESS_ID` - optional server-only canonical business UUID for rehearsing proactive invitations on exactly one public widget while the broad switch remains off. Whitespace, lists, wildcards, and malformed identifiers fail closed. Remove it after rehearsal, and never create a `NEXT_PUBLIC_` copy.
- `GOOGLE_CLIENT_ID` - server-side Google OAuth client ID for Calendar access.
- `GOOGLE_CLIENT_SECRET` - server-only Google OAuth client secret. Never expose it through a `NEXT_PUBLIC_` variable.
- `GOOGLE_REDIRECT_URI` - exact canonical callback URL: the origin from `NEXT_PUBLIC_APP_URL` followed by `/api/google/callback`. A different origin, path, query, fragment, or embedded credential fails closed.
- `CRON_SECRET` - server-only bearer secret for `POST /api/account/cleanup`. It must exactly match the `Authorization: Bearer <CRON_SECRET>` header held by the single cron-job.org scheduler; do not reuse the metrics-report scheduler secret.
- `CALENDAR_BOOKING_MIN_LEAD_MINUTES` - optional integer lead time for AI-created calendar bookings. Unset or empty defaults to `60`; valid range is `0` through `43200`. An explicitly malformed or out-of-range value makes calendar availability and booking fail closed.
- `CALENDAR_BOOKING_MAX_HORIZON_DAYS` - optional integer maximum future booking horizon. Unset or empty defaults to `90`; valid range is `1` through `365`. An explicitly malformed or out-of-range value makes calendar availability and booking fail closed.
- `SIMPLASSIST_ADMIN_USER_IDS` - comma-separated Supabase auth user IDs allowed into `/admin`; unset or empty means nobody is admin. Entries must be dedicated admin-only auth users — never a login that owns a customer business, because permanent account cleanup deletes the owning auth user (and would take the admin login with it). Decoupled 2026-07-24.

Both chat-only switches fail closed for every value except the exact string `1`.
They remain separate because direct Stripe sales and externally invoiced partner
assignments have independent release schedules. See
[`docs/chat-only-phase0-safety-baseline.md`](docs/chat-only-phase0-safety-baseline.md)
for the pre-implementation inventory and regression gate.

Production Stripe mode is fixed for the lifetime of a deployment and its
database evidence. Phase 4 completed hosted preparation and compatible
deployment on the existing live key, live Prices, and live webhook endpoint; it
never swapped to test mode and it created no Chat Only Checkout, subscription,
or charge. The owner intentionally moved the one new-account real $10 payment
and product acceptance to Phase 7. The owner alone enters payment details. The
exact canary is removed after verification, but cancellation or refund is not
implied: the owner decides whether the founding subscription remains active.

The switches gate new acquisition and partner assignment only. They do not
turn off the metering, widget-security, or calendar-lifecycle code used by
existing plans, so migrations 060-066 and their existing-plan regression gates
must be treated as production changes even while both switches remain `0`.

Before setting either switch to `1`, configure managed edge/WAF rate limiting
for `/api/widget/config`, `/api/widget/chat`, `/api/widget/end`, and
`/api/widget/lead`, plus `/api/widget/telemetry`. The application has
business-independent shared ingress
limits, but distributed source-IP rotation still requires an edge control and
is a mandatory hosted launch gate.

The local Phase 2 direct purchase and no-SMS onboarding contract is documented
in [`docs/chat-only-phase2-direct-flow.md`](docs/chat-only-phase2-direct-flow.md).
Keep both acquisition switches off until the authoritative 200-reply meter,
widget abuse controls, and launch acceptance checks are complete.

The Phase 3 metering, widget security, calendar safety, offline-lead, and
deployment contract is documented in
[`docs/chat-only-phase3-metering-and-widget-security.md`](docs/chat-only-phase3-metering-and-widget-security.md).
The authenticated Railway account-cleanup heartbeat, including calendar
provider reconciliation and its exact cron-job.org configuration, is documented
in [`docs/account-cleanup-scheduler-operations.md`](docs/account-cleanup-scheduler-operations.md).
The Phase 4 isolated direct-canary, Checkout single-flight, rollback, and
hosted approval boundaries are documented in
[`docs/chat-only-phase4-direct-canary.md`](docs/chat-only-phase4-direct-canary.md).
The Phase 5–7 completion contract is documented in
[`docs/chat-only-phase5-public-launch-readiness.md`](docs/chat-only-phase5-public-launch-readiness.md):
Phase 5 prepares public presentation locally with all acquisition flags off;
Phase 6 deploys and rehearses with the flags off; Phase 7 performs the
owner-led new-account live $10 acceptance and only then permits a separately
approved monitored broad-direct launch. Partner Chat Only and cross-family
transitions remain independent, default-off future work.

The proactive desktop/mobile invitation, privacy boundary, five-path edge
contract, canary-to-broad rollout, monitoring, and rollback are documented in
[`docs/proactive-widget-rollout.md`](docs/proactive-widget-rollout.md).

The richer multi-page website scan, dedicated Railway worker, approval
boundary, canary rollout, monitoring, and rollback are documented in
[`docs/richer-website-scan-rollout.md`](docs/richer-website-scan-rollout.md).

The Full Suite waitlist uses these server-only deployment variables:

- `RESEND_API_KEY` - Resend API key used for waitlist confirmation emails.
- `RESEND_FROM_EMAIL` - optional from-address override. Defaults to `SimplAssist <notifications@simplassist.com>`.
- `WAITLIST_UNSUBSCRIBE_SECRET` - secret used to sign waitlist unsubscribe links. Set this to at least 32 cryptographically random bytes and never expose it through a `NEXT_PUBLIC_` variable.

You can start editing the page by modifying `src/app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to optimize and load the Geist font locally.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Railway operations

Owner booking SMS alerts use the separate, default-off platform sender and
independent worker described in
[`docs/owner-booking-alerts-operations.md`](docs/owner-booking-alerts-operations.md).
Apply migration 093 before its application release; keep sending disabled until
the implemented consent flow and revised Telnyx campaign have been reviewed.

Railway is the application host. Database migrations are applied separately to
Supabase and must precede any Railway application version that calls their new
RPCs or reads their new columns. Migration 063 was not safe as an ordinary
rolling change. Its historical cutover contract was to block and drain old
calendar create/update/delete, AI booking, OAuth-completion, refresh, and
disconnect traffic; run the documented preflights; apply through migration
064; deploy the compatible application and reconciler; then reopen calendar
traffic only after verification. The current 065–066 proactive-widget change
is a separate additive rollout: apply both migrations before deploying the
application version that reads their schema, then use the canary procedure in
the proactive-widget runbook.

Railway does not schedule account cleanup. Keep exactly one external
cron-job.org job for `POST https://simplassist.com/api/account/cleanup`, with
the matching `CRON_SECRET`; do not add a Railway cron service or a duplicate
scheduler. Hosted migration, environment, WAF/CDN, scheduler, Stripe, Telnyx,
deployment, flag, and traffic-drain actions require a separately approved
release step.
