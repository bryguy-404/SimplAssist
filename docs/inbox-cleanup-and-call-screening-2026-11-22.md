# Inbox cleanup and inbound call screening — November 22, 2026

## Scope and release status

Implemented: the inbox tab is **Chat**; owners can select conversations and delete up to 100 in one confirmed batch, including completed voice calls. Search/tab changes clear selection. Failures remain visible and do not pretend that a deletion succeeded. Demo-mode deletion changes fixture state only and makes no deletion request.

Bryan approved the database update and application deployment on November 22. The production database migration and Railway application release are complete and independently verified. No real conversations were deleted, no Telnyx settings were changed, and no automatic spam classifier was enabled during this work.

`supabase/migrations/20261122071820_inbox_bulk_deletion.sql` was applied before deploying the application. Both single and batch deletion require its `delete_inbox_conversations` RPC. The migration adds one service-only, security-invoker function; it changes no existing rows or policies.

The separate production approval specified in the repository README was received. The live owner inbox shows Chat and working selection controls. Actual deletion was exercised with disposable local fixtures, not real production conversations. Voice screening remains a separately scoped step. Application rollback can leave the additive function installed; older code retains its older deletion behavior.

## Deletion contract

- Resolve fresh workspace ownership and every selected channel's plan access before calling the database.
- Validate 1–100 UUIDs, normalize duplicates, and reject missing/foreign IDs before mutation.
- The RPC rechecks business ownership and locks the business and selected conversations. It checks dependants after locking, preventing a new appointment FK from racing deletion.
- Reject the entire batch when a selected call is active, a linked voice session is active, or a calendar booking references a selected conversation/message. Conversations with bookings are visibly excluded from selection.
- Delete only the explicit selected conversation IDs. Related SMS conversations are not implicitly selected when a voice call is selected.
- Keep contacts (including their opt-out state), protected appointments, voice sessions, usage records, and recording cleanup identities. Voice transcripts remain read-only. Selected voice history is removed from the inbox; existing recording expiration remains in effect. This is not an immediate purge of provider recordings or all underlying voice data.
- No live calls, SMS sends, provider deletions, or calendar operations are performed by cleanup.

## Review of the signed-in account

Ten call transcripts were sampled through Bryan's signed-in browser, rather than classifying the entire inbox from phone numbers or duration:

| Observed pattern | Assessment |
| --- | --- |
| Seven calls used the same or closely matching Google-listing script, including instructions to press zero to speak to an agent. Six were on November 18, and the screenshot example was October 29. | High-confidence automated solicitation pattern; the actual caller identity was not verified. |
| November 2 caller ending 8737 asked specific questions about purchasing the service and installing the widget. | Apparent genuine customer inquiry; preserve for follow-up. |
| November 20 caller ending 0059 referred to an earlier email and requested a person. | Human follow-up context, but legitimacy/intent remains uncertain; review. |
| Caller ending 8133 had no available transcript. | Insufficient evidence; silence or missing transcription is not proof of spam. |

The sample also showed the AI engaging with recorded solicitations and missed-call texts appearing for some of those numbers. The voice webhook currently does not consume `call_screening_result`. A read-only Telnyx API check on November 22 confirmed that inbound screening is **disabled** on Bryan's active SimplAssist number ending 8634.

Telnyx exposes `PATCH /phone_numbers/{id}/voice` with `inbound_call_screening` values `disabled`, `flag_calls`, and `reject_calls`. A future SimplAssist setting can offer Off / Flag suspected spam / Block suspected spam and save the corresponding setting for the authenticated business's own number. Customers would not need Telnyx accounts or provider credentials. Until that integration exists, Bryan/admin must manage the carrier setting; enabling it alone does not display an inbox badge or suppress follow-up SMS. Manually marking/blocking individual callers is a separate application feature. The carrier checks reputation and caller identity, not the Google pitch's spoken content, so detection of these exact callers cannot be guaranteed.

## Recommended prevention rollout (not implemented)

1. **Pilot Telnyx Flag Calls on the SimplTexting number.** In Mission Control: My Numbers → select the number → Edit → Voice → Enable Inbound Call Screening → Flag Calls → Save. Telnyx currently documents this feature as free. Its flag mode passes the call through and includes `call_screening_result: spam_likely` in `call.initiated`; reject mode blocks suspected calls before they reach the application. Flagging alone does not change this app's UI or SMS behavior today.
2. **Persist the carrier verdict and reason in the application.** Preserve it through the call lifecycle, retries, voice fallback worker, and SMS eligibility decision. A later event missing the flag must not reset a known verdict. Keep flags distinct from confirmed spam.
3. **Add a reviewable Suspected spam section.** Include Mark as spam, Not spam, and explicit per-business block/allow controls. Use an explicit trusted-caller decision, not mere presence in contacts: inbound calls already create contact records. Do not automatically delete records or mark every unanswered call as spam.
4. **Suppress missed-call/fallback texts for flagged calls.** Enforce the decision in every fallback path before sending. Preserve normal consent and opt-out checks. Unflagged legitimate missed callers should keep the current follow-up behavior.
5. **Add conservative transcript classification for missed cases.** Combine carrier evidence with repeated promotional scripts, prerecorded menu prompts, and conversational behavior. Separate likely solicitation, genuine inquiry, and uncertain/no-content calls. Do not label every mention of Google, every short call, or every local-looking caller ID as spam. Keep reasons visible and allow correction.
6. **Review the pilot before rolling out to new and existing customer numbers.** Track false positives, customer calls preserved, spam volume reaching the AI, and avoided fallback texts. Explicit number blocks help with repeat numbers but cannot reliably stop rotating or spoofed numbers. Evaluate Reject Calls only after reviewing the impact and agreeing on the desired policy.

Telnyx screening is documented for US/Canada reputation screening and North American STIR/SHAKEN validation; do not assume worldwide coverage. Google also legitimately makes some automated calls for business details and customer requests. These should not be rejected solely because they mention Google.

Documentation details to confirm during a screening pilot: Telnyx's support article says screening is free as of March 17, 2026, while the API field description still mentions a monthly cost. The support prose describes a `spam_likely` webhook value, but its example uses a structured object. Verify account pricing and actual signed webhook payloads before implementing the integration; do not rely on an assumed single payload shape.

Sources checked November 22, 2026:
- [Telnyx Inbound Call Screening](https://support.telnyx.com/en/articles/8037040-inbound-call-screening)
- [Telnyx: Update a phone number with voice settings](https://developers.telnyx.com/api-reference/phone-number-configurations/update-a-phone-number-with-voice-settings)
- [Google: Help protect against fraudulent calls and texts](https://support.google.com/business/answer/6212928)
- [Google: About automated calls and texts](https://support.google.com/business/answer/7690269)

## Verification

- 21 PostgreSQL assertions passed on the existing local Supabase container using generated fixtures in a transaction that rolled back, including the new function itself. Covered mixed-channel deletion, tenant/owner checks, service-only permissions, atomic refusal for active/booked calls, retained contacts, retained appointments, unchanged voice usage, and retained recording cleanup.
- 139 targeted tests passed across 13 files, including both deletion routes, conversation components, deletion eligibility, voice review, fresh workspace access, and the inbox page's tenant-scoped server-only appointment lookup.
- TypeScript (`tsc --noEmit --incremental false`), scoped ESLint, and `git diff --check` passed on the final implementation.
- The actual inbox components were exercised in the local demo browser: selection counts, select all, selection clearing on tab change, confirmation cancellation, deleting two fixture conversations, and excluding active/booked call examples. Demo rendering is separate from the authenticated route and PostgreSQL tests; no production delete was used as a test.

Local demo preview: `output/inbox-cleanup-2026-11-22/selection-preview.jpg`.

## Production release evidence

- Supabase project: `inmgpkurctttsofpywuz` (SimplAssist). Only migration `20261122071820_inbox_bulk_deletion` was applied, atomically with its history entry. Stored canonical SQL matches local bytes (MD5 `7e0f059c729dff06f41cad58e7bd9bf9`).
- Verified security-invoker mode, empty search path, service-role execute permission, and denied anonymous/authenticated direct execution. Hosted RPC checks refused an empty selection and anonymous execution without changing any rows.
- Before/after counts matched: 249 conversations, 12,711 messages, 200 contacts, 162 voice sessions, and zero calendar bookings. No customer history was removed.
- Production preflight found appointment and voice records are server-only. The page and API use privileged reads only after workspace authorization, always restricted to the current business; database client grants were not widened. The final regression checks and production build passed after this correction.
- Release snapshot: clean Git archive of `8d4444a2874f9e2bb88f2b3300e1af43ea3a222a` plus the 13 scoped inbox code/test/migration/document files. Unrelated working-tree edits, credentials, dependencies, and build artifacts were excluded. Archive SHA-256: `836c1615d9873ce3622242b4098a598fe4ef395d569fbf20b90327ce892acf7b`.
- Prior web deployment / rollback target: `39e9c398-e8cb-42a7-885a-7eabc392324c`. Worker deployments and provider settings are outside this release.
- Web deployment `dff2f72c-943b-4a62-bfaf-c8a5f031482b` reached `SUCCESS` at `2026-11-22T07:42:28.505Z`. All four worker deployments remained unchanged, and the environment had no staged configuration changes.
- Signed-in live browser verification passed: Chat renders on one line; Voice selection accepts two completed calls and shows the correct count; the deletion confirmation describes permanent inbox/message removal and retained contacts/recording expiration; Cancel preserves the selection; changing tabs clears it; leaving selection mode restores the original 226 owner conversations. No browser console errors were captured. No live deletion was submitted.
- `/api/health` returned 200 and anonymous `DELETE /api/conversations` returned 401. The checked deployment HTTP log window contained no 5xx responses. Startup logs contained only npm's production-option warning and the optional Next.js sharp recommendation, with no application failure.
- Live screenshot: `output/inbox-cleanup-2026-11-22/live-selection.jpg`. Selection was canceled after capture; no calls in the screenshot were removed.
