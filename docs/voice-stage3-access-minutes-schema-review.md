# Voice access and minutes: database verification

September 17, 2026. Scope: migrations 081–083 and their local database tests. This report records implementation evidence; production schema verification is a separate deployment check.

## Result

- Final complete local database suite: **71 files, 3,095 assertions passed**.
- Final focused accounting/concurrency suite: **2 files, 81 assertions passed**.
- The isolated `SimplAssistVoice` stack used the pinned Supabase CLI **2.115.0**, PostgreSQL 17, and local API/database ports **55321/55322**. The production database and the original local stack were not test targets.
- A complete guarded migration replay passed before the final RPC-only patch. The final patch was applied with `CREATE OR REPLACE` to the same verified disposable database, then both focused and complete suites passed without a reset.
- The concurrency fixtures remove their own durable test records under the existing disposable-database attestation. Application cleanup never disables accounting protection or deletes usage to refund minutes.

Final test logs: `/private/tmp/voice-083-db-4.log` and `/private/tmp/voice-083-db-final.log`. These are temporary local verification artifacts.

## Contracts and isolation

Migration 081 adds default-off commercial rollout controls, business preferences, billing projections, immutable allowance periods, and customer call accounting. No business is added to the rollout list. Existing calls retain `access_source = 'pilot'`.

Migration 082 provides service-only billing reconciliation, settings, summary, admission, conversation-time evidence, settlement, and recovery RPCs. A reconciliation ticket precedes the authoritative billing fetch. Canonical subscription/customer identities and ticket freshness are checked before the legacy subscription write and voice projection are applied in one transaction. Missing dates preserve the last verified boundary while failing admission closed; overlapping or rewound periods cannot mint another allowance.

Migration 083 adds commercial branches to stream activation, action authorization, provider usage, and finalization. The private pilot keeps its provider-time budget and prior-disclosure rules. Commercial customer time never comes from provider session duration. Booking and commercial prewarming remain unavailable.

The global capacity lock serializes admission across businesses and the pilot. Each commercial reservation belongs permanently to its original allowance period. A source-history deletion cannot erase or refund it.

## Continuation and settlement

An admitted call may finish after an ordinary mode or billing change. Suspension, deletion, emergency stop, number reassignment, and deadline expiry revoke continuation. Contact capture uses the admitted grant; signup SMS still requires its independent current messaging eligibility. Existing proposal, playback, confirmation, and execution RPCs were exercised with a commercial call.

Customer time requires an audible-start candidate, its matching phone playback acknowledgment, and verified phone-end evidence. Provider close duration is independent. Missing evidence retains the reservation. Proven termination starts a 24-hour recovery window; unresolved customer time is waived with an audit record afterward. A late provider event cannot increase a finalized customer deduction.

Termination without an exact phone-end timestamp sets `provider_hangup_confirmed_at`, leaves `phone_ended_at` unset, and retains the hold until settlement. This avoids repeated hangup recovery without inventing an end time.

## Deletion and lock review

Lock order is:

- Admission: global capacity → business → preferences → allowance period.
- Billing: business → billing projection.
- Customer meter: business → original allowance period → usage record → session.

Commercial call history cannot be deleted before customer accounting settles. This preserves termination/reconciliation identity and prevents a session-delete foreign-key update from deadlocking a late end event. Once settled, meter retries return without updating the session; history deletion only clears the accounting reference. Business deletion removes identifying ownership links, while minimal non-content accounting remains.

Independent reviews identified and verified fixes for the original deletion/settlement lock inversions, canonical billing-source substitution, missing-period boundary erasure, and fallback-only settings edits after access loss. The final second review reported no remaining source-level blocker.

A local `pg_depend` catalog query found **zero persistent dependent objects** referring to the renamed pilot-only legacy RPCs. Commercial proposal/claim/execution tests independently verify that their callers resolve the new access policy.

## Regression coverage

The new tests cover tenant and owner isolation, service-only writes, closed rollout, ordinary call draining, emergency revocation, two-business global capacity, concurrent reservations for the last 110 seconds, exact-once customer settlement, provider/customer clock separation, canonical source and ticket rejection, one-time upgrade proration, immutable grants, malformed/overlapping periods, fallback suppression, termination recovery, and accounting retention after history/account deletion.

The deletion race deliberately holds the session row until a late end event is waiting for it, then attempts deletion. The unsettled deletion is rejected and the end event completes without a deadlock. The existing SMS, website chat, pilot, knowledge, contact, confirmation, Leads, and billing database suites also pass.

Commercial purchases and rollout remain closed. These checks do not replace the later multi-business, actual booking, public greeting/recording, invoice reconciliation, or customer phone acceptance work.
