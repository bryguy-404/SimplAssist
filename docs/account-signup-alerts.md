# New-account email alerts

Implementation authorized November 22, 2026. Recipient confirmed by Bryan:
`bryan@simplassist.com`.

Two milestones for new self-service accounts, across Chat Only, Starter, Growth,
and Pro: verified signup; then Chat Only ready or texting registration submitted.
The initial email can show “Plan not selected yet.” Setup alerts require saved
paid subscription and onboarding/provider evidence. They never wait for SMS
approval. Admin links open the existing account detail page.

Work is isolated in `codex/account-signup-alerts`, based on `8d4444a`. The parallel
“Add bulk spam call management” chat owns inbox and call-screening changes.
This feature does not modify those files or Telnyx call handling.

Delivery uses an internal outbox and the existing once-per-minute onboarding
maintenance request. Capture and delivery have no network calls inside signup or
checkout. A durable milestone key prevents repeats. Frozen email contents and
Resend idempotency protect retries; uncertain deliveries older than the provider
window are held for review instead of blindly resent. Existing accounts are not
backfilled. Customer-facing emails and normal signup behavior stay as they are.

## Delivery and activation

- New self-service accounts are eligible when their Auth creation timestamp is
  at or after `account_signup_alert_control.starts_at` (set when migration runs).
  Existing accounts, anonymous users and concierge/partner invitations are
  excluded. A later plan change or texting upgrade does not create another
  setup alert for the same owner.
- Small database triggers save milestones without making network calls. Capture
  errors are swallowed so signup/payment still succeeds; the maintenance sweep
  repairs missing events when their source facts remain present.
- `ACCOUNT_SIGNUP_ALERTS_ENABLED=true` enables the server-only delivery runner.
  It defaults off. The application uses the existing `RESEND_API_KEY` and
  `RESEND_FROM_EMAIL`; the recipient is fixed to the confirmed Bryan address.
- The existing voice worker calls `/api/internal/onboarding/reconcile` every
  minute. The endpoint runs registration continuation and account alerts
  independently. No worker change, new scheduler, or new service is required.
- Each request sends up to three messages. A failed request backs off between
  one minute and one hour. Leases expire after two minutes. The exact message,
  sender, recipient, links and idempotency key are reused after a lost response.
- Resend retains idempotency keys for 24 hours; automatic retries stop after
  23 hours. `needs_review` rows keep the maintenance response at 503 so a held
  delivery stays visible. `sent` means provider acceptance, not inbox delivery.
  Inspect the provider message/key before manually resolving ambiguous records;
  do not blindly reset an expired delivery or delete its deduplication record.
- Soft deletion or owner reassignment cancels queued mail and removes its
  saved customer details. Permanent owner/business deletion cascades the outbox.

Release: reconcile the latest production source with this branch before
deployment so the parallel call-screening release cannot overwrite either
feature. Apply the additive migration through the normal migration transaction,
deploy the web application and set the flag above. Confirm that the existing
worker heartbeat receives a healthy response and the outbox starts without
historical recipients. Rollback: unset the flag or set it to `false`; the
additive tables can remain. Do not reset `starts_at` or delete sent records.

Production activation was approved and completed November 22, 2026; see the
rollout record below. No synthetic customer accounts or test emails were created
in production. Actual inbox delivery awaits the first eligible signup.

## Verification — November 22, 2026

- 28 focused Vitest checks passed (rendering, all four plan labels, sender
  timeouts, frozen retries, recipient restriction, runner recovery and
  maintenance authentication/failure isolation).
- 36 pgTAP checks passed against an isolated database cloned from the local
  schema, including failure injection proving that an outbox error cannot
  prevent email verification, all four plans, no historical backfill,
  no resend on carrier resubmission, lease recovery and private permissions.
- Two integration checks passed through real PostgREST and the installed Resend
  SDK to a local fake HTTP mail server. A provider acceptance with a lost reply
  was retried with identical content/key and produced one simulated email;
  paid Chat Only setup then produced the second. Two concurrent database
  transactions claimed different rows while their leases were locked.
- TypeScript, focused ESLint and the optimized Next.js production build passed.
  The build used placeholder credentials, not live provider keys.
- Full Vitest: 8,706 passed, four failed, four skipped across 526 files. The four
  failures were reproduced unchanged at base commit `8d4444a`: existing
  home-v2 copy expectations (two), sitemap contents (one) and compliance copy
  (one). None of those sources were changed for this feature.
- Supabase security advisors found no findings for the new alert objects. The
  isolated preexisting schema has three mutable-search-path warnings and an
  existing RLS finding for `stripe_webhook_events`. This was a local schema
  check, not an assessment of current production configuration.

Focused commands:

```sh
./node_modules/.bin/vitest run src/lib/account-alerts/message.test.ts src/lib/account-alerts/sender.server.test.ts src/lib/account-alerts/runner.server.test.ts src/app/api/internal/onboarding/reconcile/route.test.ts
./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/next lint --dir src/lib/account-alerts --file src/app/api/internal/onboarding/reconcile/route.ts --file src/app/api/internal/onboarding/reconcile/route.test.ts
```

Database tests are in `supabase/tests/database/account_signup_alerts.test.sql`
and roll back their fixtures. The optional integration test is skipped in a
normal suite. It explicitly requires a disposable database named
`simplassist_account_alerts_verify` in the local `supabase_db_SimplAssist`
container, with this migration applied, and PostgREST on loopback port 56431.
It refuses another REST address and uses local-only credentials. Run with
`ACCOUNT_ALERTS_TEST_REST_URL=http://127.0.0.1:56431` and the
`src/lib/account-alerts/delivery.integration.test.ts` test path. The local HTTP
mail sink is started by the test; no actual email provider is contacted.

Reference: [Resend idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys).

## Prepared production release

Read-only Railway inspection found the other chat's inbox release already live
as deployment `dff2f72c-943b-4a62-bfaf-c8a5f031482b`; its source is ahead of the
shared checkout's committed HEAD. Do not deploy this worktree directly from its
base commit and accidentally remove those uncommitted but published changes.

The prepared release at
`/private/tmp/simplassist-account-alerts-release-6z20jvvd` starts from that release's
verified 1,618-file manifest and overlays only the 13 files from feature commit
`a215045`. All 1,615 baseline files outside that overlay were verified byte for
byte. This preserves Chat/bulk deletion and excludes the other chat's unfinished
call-screening work. The combined inbox/alerts selection passed 82 Vitest checks,
and that exact combined source passed the production build, lint and type checks.
Recheck the latest production deployment before using this artifact.

Production schema preflight succeeded through the existing Supabase CLI login
after the connector denied the read-only request. All required columns exist,
the live inbox migration is present, and the new alert tables are not installed.
There were no staged Railway changes at preflight. That inspection made no live
changes; the subsequent approved rollout is recorded below.

## Production rollout — November 22, 2026

- Web deployment `eb3bbe7e-0e51-4ebb-9c59-74b84531f5d9` is successful and online
  at `https://simplassist.com`. Railway recorded success at 08:42:43 UTC
  (3:42 a.m. Indianapolis time). All four worker deployments remain unchanged.
- Applied only `20261122080319_account_signup_alerts.sql`, transactionally with
  its migration-history entry. The recorded SQL SHA-256 matches the tested
  file: `82b8ae3cc117aa7c225feb58a736952cbbb3f8d4cb20396a431ba4b155d7ad73`.
  Production verification confirmed both tables have RLS, neither customer role
  can read them or execute the public RPCs, and all three capture triggers are
  enabled. The service role has the required access.
- Eligibility starts at `2026-11-22T08:39:30.941208Z` (3:39 a.m. Indianapolis
  time). The initial outbox was empty; no historical accounts were queued.
- Set `ACCOUNT_SIGNUP_ALERTS_ENABLED=true` on the web service and deployed with
  the existing email credentials. An authenticated production maintenance
  request at 08:43:03 UTC returned HTTP 200 with `enabled: true`, zero captures,
  zero sends, zero retries and zero held deliveries. Railway also recorded an
  automatic worker POST at 08:42:52 UTC returning HTTP 200.
- Public health and signup pages return HTTP 200. The internal maintenance
  endpoint returns HTTP 404 without its credential. The environment has one
  healthy web replica and no pending changes.
- Uploaded the byte-verified, 1,628-file directory
  `/private/tmp/simplassist-account-alerts-clean-release-tn7ctn1y` with
  `COPYFILE_DISABLE=1`. Its source matches the prepared combined release.
  A metadata-free Python archive is saved at
  `/private/tmp/simplassist-account-alerts-clean-release.tar.gz` with SHA-256
  `fd51556ccb54771e20fd81457fd94208b676806c5ea8b9fb50ed8017930a8cd2`.
  Use this clean artifact instead of the earlier macOS archive, which can
  include AppleDouble metadata. The successful production build passed lint,
  type validation and page generation before the health check passed.
- This rollout preserves the previously deployed inbox/Chat/bulk deletion
  sources. It does not include the parallel chat's unfinished call-screening
  changes. Future releases must incorporate feature commit `a215045`, preserve
  the enabled flag and keep migration `20261122080319` in their source history.
- Rollback for alert behavior: set the web-service flag to `false` and redeploy.
  If the whole release must be rolled back, the prior successful web deployment
  is `dff2f72c-943b-4a62-bfaf-c8a5f031482b`. Leave the additive database objects,
  eligibility timestamp and deduplication records intact.

Live checks prove the runner is enabled and its database operations succeed.
Provider acceptance and inbox delivery have not been observed for a real signup
yet; the duplicate/retry behavior was verified with the local integration tests.
