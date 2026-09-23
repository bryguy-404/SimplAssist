# Production schema verification — September 23, 2026

Migrations **091** (`chat_texting_upgrades`) and **092** (`voice_accounting_cleanup`) were applied successfully to the existing **SimplAssist** Supabase project, reference `inmgpkurctttsofpywuz`. This step changed the database schema only. Application/worker deployment, webhook configuration, scheduler creation, and customer rollout remain separate release steps.

## Application and verification

The pinned Supabase CLI was `2.115.0`. Preflight confirmed migration history ended at 090, the new objects were absent, and the function signatures/replacement anchors required by 091 matched. A fresh dry run proposed only 091 and 092. The cleanup index covered a table with two rows and an 8,192-byte heap; no conflicting locks or transactions older than 60 seconds were observed.

The authorized apply command was `npx --yes supabase@2.115.0 db push --linked --skip-vault --yes`. It completed with exit code 0 and applied exactly those two migrations. No seeds, role changes, migration repairs, or resets were requested. A subsequent migration listing confirmed local and remote versions 001–092 match, with no pending migrations. One intervening read-only check encountered a transient pooler authentication timeout; the later listing succeeded. The migration command was not repeated.

Independent pre- and post-application queries used `BEGIN READ ONLY`, a 15-second statement timeout, and a two-second lock timeout. They read catalog metadata and aggregate fingerprints only. The baseline catalog was observed at **18:37:56 UTC**; the post-application catalog at **18:39:30 UTC**.

| Verification | Result |
| --- | --- |
| Recorded migration SQL | All 53 statements in 091 and all 6 statements in 092 match the reviewed local statement contents exactly; only serialization separators differ |
| Upgrade ledger | Present, empty, RLS enabled, no public policies |
| Upgrade table permissions | `service_role` has SELECT only; `anon` and `authenticated` have no SELECT/INSERT/UPDATE/DELETE rights |
| Function permissions | All 23 inspected upgrade/cleanup functions match intended service/private grants; PUBLIC, `anon`, and `authenticated` cannot execute them |
| Private compatibility aliases | All three exist and are not executable by `service_role`, `anon`, `authenticated`, or PUBLIC |
| Cleanup index | Partial `business_id` index exists, valid and ready |
| Cleanup trigger | Expected BEFORE DELETE trigger on `businesses` exists and is enabled |
| Upgrade triggers | Authority, operation-expiry, and draft-cleanup triggers all exist and are enabled |
| Existing business/billing/usage data | All ten aggregate row-count and fingerprint comparisons were unchanged |

The data comparisons covered complete subscription, SMS billing-operation/account, plan-family-lock, SMS usage-period/event, AI usage-period/reservation, and voice-usage rows, plus selected business ownership, billing, onboarding, deletion, and suspension fields. No customer records or provider identifiers were returned by the queries. These observations verify schema installation and preservation of the compared data; they do not substitute for the deployed application canary or live carrier readiness checks.

## Reviewed file hashes

| Migration | SHA-256 |
| --- | --- |
| 091 | `83593b06279e46584076f905fadbb6ecf6a5dc9aebe49fc5b63d37c54581dcbf` |
| 092 | `3928b5bf0b09a78df2091a581a4bb9de4fb4827e65b8f31fa73f538d79649035` |

Local audit evidence is retained in `/private/tmp/chat-texting-schema-independent-*.json`, including the before/after catalog snapshots, unchanged-data comparison, and statement comparison. The recorded SQL is also retained in `/private/tmp/chat-texting-schema-recorded-091.sql` and `/private/tmp/chat-texting-schema-recorded-092.sql`.

## Next release step

Deploy the complete compatible web application and workers with new upgrades disabled, following the [controlled release guide](./chat-texting-upgrades.md). No application deployment, production feature-flag change, Stripe/Telnyx operation, scheduler change, or paid conversion was performed in this schema step. Keep the migration history intact; later rollback must follow the compatibility rules in that guide.
