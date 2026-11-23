# Call screening and Spam inbox

## Approved implementation

Implement the November 22 phased plan. Keep normal answering/forwarding, make screening opt-in, add per-completed-call Mark as spam / Not spam, and retain the existing 100-item deletion protections. Restoring affects one call only and never sends delayed texts. Suppress automatic missed-call/fallback SMS, not explicitly requested actions. Independent SMS/chat classification, blocking and trusted-number lists are excluded.

## Checkpoints

1. Service-controlled call evidence, settings synchronization, conversation projection and deletion tombstones.
2. Verified inbound events and every automatic follow-up path, including maintenance recovery.
3. Server-paginated Inbox/Spam, review actions and customer settings.
4. Automated/database/browser verification, then a separately approved production release and Bryan-only pilot.

The deployed bulk deletion implementation is the feature baseline; its scoped source was copied to `/tmp/simplassist-screening-baseline-o6rd2h3d` before edits. Unrelated working-tree changes were preserved. The separately deployed account-alert feature is included in the final combined release, as recorded below.

## Release boundaries

New additive migrations precede the compatible application. `CALL_SCREENING_ENABLED=1` exposes opt-in settings broadly; `CALL_SCREENING_PILOT_BUSINESS_ID` exposes them for one exact business while the broad switch is off. Both default closed. These settings gate new provider activation, not processing of already flagged calls or access to retained history. Turning screening off must remain possible.

Telnyx's support article documents `spam_likely` and free screening; its API page has conflicting cost wording and the support example includes a different payload shape. Unknown shapes stay unclassified. Verify actual provider readback, pricing and a real signed flagged event during the pilot; mocked evidence is not carrier acceptance. No broad activation before the pilot passes. No hosted migration, deployment or Telnyx update is performed solely by local implementation commands.

## Verification status

Local implementation and verification are complete. The new screening migration, application release and carrier activation have not been applied to production.

- **114 PostgreSQL assertions passed** with all three schema layers applied together in rollback-only transactions: 21 existing deletion checks, 36 account-alert checks and 57 screening checks. Covered tenant isolation, protected appointments, unknown evidence, manual override, suppression, deletion markers, settings leases/readback and paging through more than 1,000 spam records. No local reset or hosted migration.
- **723 targeted application tests passed across 47 files** in the combined screening/FAQ/account-alert source. The account-alert suite's two opt-in database/HTTP integration tests were skipped in this normal run; their prior isolated verification is documented in `docs/account-signup-alerts.md`.
- The final combined optimized production build passed, including lint, TypeScript and page generation, using placeholder/local credentials. Scoped ESLint and `git diff --check` also passed.
- Browser → real Next APIs → isolated PostgREST/Postgres → browser verified: Spam filtering over 100 records, page two, manual old-call marking, one-call restoration, selection cap, search reset, and confirmation/deletion of five disposable calls. One signed three-event simulated carrier flow answered normally, saved a basic call record, and suppressed automatic SMS before creating another text thread. Settings changed Off → Flag → Off through the real Telnyx SDK pointed at a local simulator, with provider readback and SQL idle status confirmed. These are local integration results, not evidence that Telnyx has flagged a real call.
- The existing voice maintenance endpoint now also reconciles durable screening requests and lost terminal callbacks. Carrier work is bounded and does not affect voice-worker health. No new scheduler or worker deployment is needed.
- Recovery distinguishes a verified end time from merely confirming that a call is over. The latter does not display an invented call duration; a later signed end event can supply the real time.
- All disposable screening browser services and the isolated verification database were removed after evidence capture. The existing developer database was left intact.

## Prepared release and evidence

The combined source is `/private/tmp/simplassist-screening-release-u051pyoz`. Its source-only archive is `output/call-screening-2026-11-22/call-screening-release.tar.gz`; `release-manifest.json` in the same output folder records every file hash, archive SHA-256, schema hash, baseline and changed paths. The package excludes environment files, credentials, dependencies, generated Next files and Mac `._*` metadata. Compare its manifest before uploading.

The same output folder contains `application-tests.txt`, `database-tests.txt`, `production-build.log`, `local-integration-evidence.json`, and three screenshots. To repeat the combined database checks from the prepared source (with dependencies available), run `node scripts/test-call-screening-local.mjs --with-account-alerts`. The root checkout can run the default command without the alert overlay. Both commands use only rollback transactions in the local `supabase_db_SimplAssist` container.

## Coordinated homepage change

The FAQ chat handed off Bryan's separately approved two additions in `src/app/(public)/home/seo.ts`. Preserve that file in the combined release; its 12 existing tests passed in that chat. See `docs/homepage-faq-release-2026-11-22.md` for original FAQ preservation and live checks. The standalone FAQ upload failed before cutover because of Mac metadata, so exclude every `._*` file and do not upload that older archive. This handoff does not authorize this feature's hosted release.

The account-alert chat subsequently completed its separately authorized release as `eb3bbe7e-0e51-4ebb-9c59-74b84531f5d9` at 08:42:43 UTC. That is now the production baseline. The combined screening release must overlay all 13 files from alert feature commit `a215045`, preserve `ACCOUNT_SIGNUP_ALERTS_ENABLED=true`, and retain migration `20261122080319_account_signup_alerts.sql` in source without reapplying it. The shared root checkout does not contain those feature files; the prepared release snapshot does. The alert worker deployments stayed unchanged. Read the final notes in `.worktrees/account-signup-alerts/docs/account-signup-alerts.md` before release.

## Hosted release and pilot checklist

1. Recheck the active production web release and compare any intervening source changes. Use the combined, verified archive; never deploy the shared root or older FAQ/alert archive by itself.
2. Apply only `20261122081018_call_screening_and_spam_inbox.sql` after a successful preflight. Prior bulk-deletion and account-alert migrations are already live. This additive migration preserves existing conversations and call handling.
3. Deploy the compatible web service. Keep both screening rollout variables closed. Verify authenticated Inbox/Spam reads, existing text/call review, protected deletion, anonymous denial, maintenance health, and the two homepage FAQ additions plus all 11 original FAQs. Keep the alert flag unchanged.
4. Separately enable the exact Bryan pilot business after confirming account-specific Telnyx pricing and the managed phone resource/ownership. Read current provider state, enable Flag through Settings, and verify provider readback. Never enable Reject.
5. Confirm one genuine call remains normal and one real signed `spam_likely` event appears in Spam without an automatic missed-call text. Review any different carrier payload shape before changing the parser. Confirm manual restoration and history remain available after Off. Do not call mocked events a passed carrier pilot.
6. Only after that pilot passes, open broad setting visibility. Every customer still chooses Off or Flag for their own number.

Rollback: close new activation flags; owners retain access to Off and stored history. If reverting the application, first return activated pilot numbers to verified Off, then use the current pre-screening web baseline that includes account alerts. Leave additive tables, review decisions, suppression and deletion markers intact; do not remove quota or deduplication records. No worker or scheduler change is required.
