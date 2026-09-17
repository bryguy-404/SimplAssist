# Voice access and minutes: independent production verification

**Passed — September 17, 2026, 06:36 UTC.** This separate verifier performed read-only queries before and after migrations 081–083. Application and worker deployment had not started during these checks. No database mutation, provider call, caller transcript/audio read, or test message was performed by this verifier.

## Method and migration identity

The workflow follows the independent verification requirement in [PROJECT_LOG.md](PROJECT_LOG.md#2-working-agreements) and the approved [access/minutes plan](voice-stage3-access-minutes-plan.md). Queries used the pinned Supabase CLI 2.115.0 against linked project `inmgpkurctttsofpywuz`, inside explicitly read-only transactions. The comparison schema came from the tested isolated `SimplAssistVoice` database on local port 55322. Its catalog was read without changing the database.

The production migration history contains one canonical statement for each migration, with these exact file MD5 values:

| Migration | Canonical and production MD5 |
| --- | --- |
| 081 — commercial foundation | `aee59ca6f996a2edc2d0b7a550c6907c` |
| 082 — monthly allowance | `1f6637afe187269b362a9004aa38f598` |
| 083 — commercial lifecycle | `61d7d3ab60dc2e4b85f027371145ecc4` |

Migration 080 remains unchanged at `b889ea920d5854f34824f4908a107792`.

## Schema and permission comparison

Production exactly matches the tested local catalog for:

- 35 relevant function signatures, normalized definitions, security modes, search-path settings, and execution grants, including the preserved pilot branches.
- Seven new tables and their exact ACLs/RLS state; 67 relevant columns; 37 constraints, including the new session foreign key and access-source check; 12 indexes; three owner-read policies; seven triggers; and the pilot totals view.
- No anonymous or authenticated execution privilege on the compared functions, and no anonymous/authenticated writes on the new tables. Owner SELECT is limited to the intended settings and accounting tables under business-scoped RLS.

The normalized comparison catalog has SHA-256 `8dfcd176d105f24275e7e1174c321be9b3798a533fba01a07a17243fdbfe718d` in both environments.

## Closed rollout and unchanged production data

Baseline: **06:21:50 UTC**. Post-migration data check: **06:36:32 UTC**. Rollout check: **06:36:39 UTC**.

| Check | Verified result |
| --- | --- |
| Commercial rollout | One control row, `enabled=false`, revision 1, capacity 2 |
| Customer allowlist | Empty |
| Commercial settings, billing projections, allowances, customer usage, audit | All empty |
| Existing call access source | All 13 calls remain pilot; no commercial reservation metadata |
| Active voice calls | Zero before and after |
| Pilot settings | Identical full-row fingerprint `047723357d09f2a95001c36bd7b75bd8`; revision 4 |
| Pilot limits/capabilities | Enabled; 12,000 lifetime seconds; two calls; 600 seconds per call; contacts/signup enabled; booking/preparation disabled |
| Approved pilot tester configuration | Identical fingerprint and count |
| Voice sessions | Identical metadata fingerprint: 13 calls, 1,716 used provider seconds, zero outstanding reservation seconds, all usage confirmed |
| Provider usage | Identical fingerprint: 74 records |
| Existing billing usage | Identical fingerprint: 45 records |
| Subscriptions | Both rows unchanged by fingerprint; pilot remains active `sms_and_chat` |
| Leads | Identical fingerprint: five total events, four from voice |

The comparison found no allowance grants, billing changes, deductions, or other measured data changes caused by the migrations.

## Purchase gates and verification limits

The candidate source still sets Full Suite to `coming_soon`. The availability and checkout suites passed **69 tests**, including rejection of a crafted new Full Suite checkout before Stripe is called. This is source/test verification of the sales gates; live Stripe configuration and subsequent application deployment are recorded by the release owner separately.

These results clear the database migration verification step. They do not establish application/worker deployment success, actual phone speech quality, protected recording playback, or commercial rollout readiness. Keep customer voice and purchases closed; complete the remaining release and approved private-pilot checks in the plan.

## Independent post-deployment check

**Passed — September 17, 2026, 06:44:46–53 UTC.** Following the release owner's deployment of source `14d96aa`, fresh read-only Railway metadata confirmed these latest deployments:

| Service | Deployment | Status |
| --- | --- | --- |
| Application | `34e7aae2-84e4-4ffb-931f-45d6c83e922c` | SUCCESS |
| Voice worker | `ff5d7285-f638-49ef-9ca7-83581be113e7` | SUCCESS |
| Scan worker, unchanged | `12c2582a-2263-4055-92a8-1f4eaf27c642` | SUCCESS; created September 10 |

The apex and www application health endpoints and the voice worker's public health endpoint each returned **200**, without redirects. The new owner voice-settings endpoint returned **401** without authentication. Credentialed worker readiness was checked separately by the release owner.

Fresh database readback matched every post-migration fingerprint: pilot settings/testers, all sessions, provider usage, billing usage, subscriptions, Leads, and migration history. The pilot fingerprint remains `047723357d09f2a95001c36bd7b75bd8`, revision 4; zero calls are active. Customer rollout is still disabled, with no allowed businesses, commercial settings, billing projections, allowances, customer usage, or audit rows. All 13 existing sessions remain pilot calls.

No runtime changes or production data mutations were performed by this verifier. Bryan will make the next live phone test later; speech quality and caller acceptance for this deployment remain unclaimed.
