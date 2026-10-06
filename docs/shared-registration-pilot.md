# Shared legal registration pilot

Status: **implemented, pushed to main, migrated, and deployed with enrollment disabled**. On October 5, the owner confirmed that the fresh Bryan Develops Chat signup is complete and supplied its dashboard screenshot. Shared enrollment and the real carrier pilot remain pending. The original release verification created no new live brand, campaign, number, subscription, or customer message; the later owner-completed signup is recorded below.

## Scope and baseline

The pilot allows two approved business accounts under the same legal company to share one verified Telnyx brand. Each account keeps its own owner authorization, website, profile, number, campaign, customers, review permissions, quota, billing, and lifecycle. Other accounts retain the existing registration flow.

Known production baseline, last inspected before enrollment:

- Existing SimplAssist business: `ea848911-ef72-44a6-8cf3-c47b3959be26`.
- Existing brand: public TCR `BL69PDP`; Telnyx internal ID `4b20019d-e93e-d697-b8ee-c6233e9bf533`.
- Existing SimplAssist campaign: `4b30019f-8814-cb6c-1e77-950fa70e0410`; the provider brand already has two campaigns. Preserve both.
- Old deleted Bryan account: `aa30a10e-13c1-4c9b-b9d5-6804cf01e6cb`. It is excluded from this pilot and must not be revived or reused.
- Fresh Bryan Develops account: owner-confirmed signup and dashboard access on October 5. Its exact business and owner IDs still need authenticated inspection before enrollment; no target membership approval has been performed in this chat.

Do not place the EIN, full legal address, credentials, or owner identifiers in this document or ordinary logs. Inspect them only through the authenticated administrative workflow when needed.

## Controls

New sharing controls default to off and remain off until the pilot prerequisites are met:

| Variable | Enabled value | Purpose |
| --- | --- | --- |
| `SHARED_REGISTRATION_ADMISSIONS_ENABLED` | `true` | Allow the administrator to approve a new member. |
| `SHARED_REGISTRATION_PAID_STARTS_ENABLED` | `true` | Allow new owner-confirmed paid setup or upgrade starts. |
| `SHARED_REGISTRATION_PILOT_BUSINESS_IDS` | Two comma-separated UUIDs | Exactly the existing SimplAssist ID plus the fresh Bryan ID. No wildcard, deleted account, or third ID is accepted. |

Turning off these new-start controls does not revoke existing membership or stop reconciliation of an already confirmed payment or provider attempt. Canonical approval, identity, ownership, billing, and lease checks still apply.

Existing review texting controls remain separate: `REVIEWS_SMS_ENABLED`, its pilot/exclusion list, `REVIEWS_SMS_PROVISIONING_ENABLED`, and `REVIEWS_SMS_SENDING_ENABLED`. Their enabled value is `1`. Existing review-upgrade flags independently govern the later guided upgrade. This pilot does not authorize enabling generic Telnyx or review-resource cleanup.

## Prepare the fresh account

1. Create a fresh Bryan Develops account through normal Chat signup; complete onboarding and the active paid Chat subscription.
2. Record its actual business ID and owner ID privately. Confirm ownership of both businesses and that they legally operate under the same verified company.
3. The target must have no carrier brand, campaign, messaging/voice profile, phone, managed resource, or paid/in-progress review setup. Its Stripe subscription must have a current paid period, with no cancellation, pending plan change, partner billing, exemption, deletion, or suspension.
4. Validate the current Bryan website and contact details. The target continues to provide its own authorized representative and DBA-specific setup details; sharing does not copy customer data or consent.
5. Deploy migrations and application support, then enable admission only for the exact two business IDs. Leave new paid starts off until the approved account and public pages have been checked.

## Administrative inspection and approval

The authenticated admin endpoint is `/api/admin/shared-business-registrations`. It derives the acting administrator from the session. Never supply an actor ID from a client or bypass its admin authorization with a public route.

`GET` uses these query parameters, or `POST` accepts the same fields with `action: "inspect"`:

```json
{
  "sourceBusinessId": "<existing SimplAssist business UUID>",
  "targetBusinessId": "<fresh Bryan business UUID>",
  "sourceOwnerId": "<current source owner UUID>",
  "targetOwnerId": "<current target owner UUID>"
}
```

Inspection checks fresh provider identity and returns a limited summary, including the provider campaign count, observation time, membership revision, and whether admission is enabled. It does not charge, create, or alter provider resources. A failed or incomplete inspection is not approval.

For `POST` approval, add `action: "approve"` and `expectedRevision` to the same object. Use `0` only when there is no target membership; otherwise use the latest inspected revision. The server re-inspects the provider and the database checks exact owners, source consumed-link evidence, retained ledger, legal identity, freshness, target eligibility, and revision in one transaction.

Approval creates the canonical registration, binds the existing source member, and approves the target member. It retains the **existing physical brand ledger row**, with its original `business_id` as provenance. It first sets the target's `public_address_visibility` to `city_state`, then copies legal identity in the same transaction. The target brand is not attached until its paid activation receipt is verified.

Verify the target's hosted contact, review-text consent, privacy, and terms pages before enabling paid starts. They may identify the legal operator and city/state, but must not publish the copied street/ZIP. The private registration address remains available for carrier submission. Do not blank or falsify it.

To revoke an unused approval, `POST`:

```json
{
  "action": "revoke",
  "businessId": "<fresh Bryan business UUID>",
  "ownerId": "<current target owner UUID>",
  "expectedRevision": 1,
  "reason": "<specific administrative reason>"
}
```

Use the current revision rather than the example value. Only an unconsumed approval without an unresolved billing operation or paid/provider setup can be revoked. Approval/revocation increments the revision; paid consumption does not. Resolve an outstanding checkout through the supported billing workflow before trying to revoke it.

## Owner activation and pricing

- Chat remains $15/month. Review texting adds $20/month, for a $35/month combined price, with 250 included SMS parts per full paid period under the existing quota rules.
- The current one-time activation is $25. Historical confirmed $49 activation receipts remain valid; do not rewrite their amounts or charge again to reuse the brand.
- The activation payload freezes registration ID, identity version, membership revision, and brand ID. The paid provisioning claim verifies that exact completed receipt and current paid Chat subscription before attaching the existing brand.
- Attaching the shared brand does not call brand creation and does not set `provider_started_at`. A refund before a real paid provider step remains possible; attachment alone cannot create SMS entitlement or change the Chat plan family.
- Provisioning creates only the target's dedicated resources and one review `MARKETING` campaign. Carrier approval and verified number assignment are still required. The review subscription begins through its normal owner-confirmed billing step when ready.
- The later guided $35 → $49 Growth conversion prepares a separate `MIXED` campaign under the same brand, preserves paid reviews while approval is pending, and requires the existing explicit sender handoff/payment process. It does not charge a second setup fee. Further Growth → Full upgrades use the existing flow.

Use the hosted `/c/{slug}/review-texts` program for real customer opt-in: the customer sends `REVIEWS` to that business's sender. Customer-care consent, another business's permissions, or a generic website checkbox never substitutes for that recorded permission. STOP remains effective; START alone does not grant review permission.

## Capacity, events, and recovery

Fresh complete provider inventory is checked before a new paid start. Immediately before campaign creation, the database reserves a brand-wide slot under a lock, combining observed provider IDs, known bound local IDs, and unresolved local attempts. The cap is five, including campaigns outside this app.

A reservation returns submission authority once. Identical retries do not authorize a second provider create, even after a worker lease expires. Lost, ambiguous, or not-submitted results retain their slot. Recover by the exact reference and full frozen filing comparison; never submit a replacement merely because a provider response was lost.

Bound reservation IDs also remain conservatively counted if they later disappear from provider inventory, including after verified campaign retirement. There is currently no automatic slot-release/reconciliation RPC. A future need to reclaim such slots requires an explicit, verified lifecycle extension; do not delete rows or ignore unresolved attempts to make capacity appear available.

Brand events are ordered against the initial fresh inspection and later observations. Canonical status and active-member status/audit changes commit together; older events cannot reopen a rejection. Tenant send and review dispatch boundaries check canonical approval for every shared member. Existing confirmed payment reconciliation and inbound control handling remain separate from new-start admission flags.

A concrete fresh provider identity mismatch places the canonical registration in `support_required` without overwriting its carrier status. Later positive carrier events cannot clear this hold. There is **no identity repair/release endpoint**: a verified support investigation and explicit repair procedure are required. A network timeout or incomplete observation must not be treated as proof of a changed identity.

Closing either account scrubs its local identity and retires its membership while retaining the canonical registration and sole brand claim. It must not delete the shared brand or either unrelated campaign. Existing provider protection manifests and scoped release controls remain in force; this pilot grants no generic resource cleanup authority.

## Local evidence

- Final application regression: 500 test files passed, 8,231 tests passed; three intentional skips. Final clean local database regression: 108 files and 4,318 assertions passed, with fixture cleanup verified.
- Production build, application TypeScript checks, ESLint, and voice/review/booking-worker TypeScript checks passed.
- Browser checks used the synthetic `/demo/shared-registration` preview: editable representative fields, locked legal fields, revoked state, keyboard navigation, mobile 390px and desktop layouts, and light/dark themes. A fresh public-policy load omitted the synthetic private street and ZIP from both visible content and page HTML; browser warning/error logs were empty. This was not a real carrier application.
- Migrations: `116_shared_business_registrations.sql` and `117_shared_registration_operations.sql`.
- Focused database tests: 107 passing assertions for approval, revisions, paid receipt/period fences, refunds, isolated ownership, both account-cleanup directions, capacity, ordered events, and identity holds.
- Concurrency tests: 13 passing assertions for admission/EIN serialization, absence of the former empty-key lock contention, and fixture cleanup.
- Existing database regressions passed locally for legacy brand reuse, account/resource cleanup, SMS billing/reservations, review accounts/provisioning, family ownership, keyword consent, provider conversion, and conversion billing.
- Existing guarded Stripe TEST provider-contract checks (8) and signed application-webhook conversion checks (9) passed with zero cleanup errors. These do not prove a new live shared-brand carrier filing or delivery.
- No production enrollment, paid carrier creation, customer send, or live carrier approval is claimed by this evidence.

## Production release — October 5, 2026

Production preflight on October 5 confirmed migration history through 115; the dry-run includes only 116 and 117, without seeds or vault changes. The shared admission, paid-start, and business allowlist variables are unset (disabled). Generic resource release remains `disabled`; review SMS release remains `0`. SimplAssist retains its active Full subscription, October 22 renewal, 83 contacts, original phone/resource bindings, and the verified Telnyx brand with two campaigns. No target enrollment exists yet.

Application revision: `7cc690a0fae2a842c01978de49c9f57643a0dffe`, in five implementation commits (`c96f6bf`, `8320ecf`, `ece54dc`, `9f25ed1`, `7cc690a`). The clean Git archive hash is `f4e9f42e4eac9f37549ffcf95aec01c4e37adbb4550d62bf2487ec9bb2cc3dc3`. Unrelated pre-existing working files were excluded.

Migrations 116 and 117 are applied to production project `inmgpkurctttsofpywuz`. Remote migration history confirms both; no seeds, roles, or vault configuration were changed. New tables/RPCs reject anonymous access (`42501`), and the existing SimplAssist SMS eligibility helper returns true.

Railway web deployment `c176226a-e03d-445b-a28b-c1fd7f7465ca` and voice deployment `936326c8-e5e4-492c-ab3a-0ea052823039` reached **SUCCESS**, with running instances and successful health checks. Voice was updated because its answer prompt also needs to respect the private-address preference. Existing build/start/health/replica settings were preserved for every service. Booking-alert and review workers retain their original deployments; the scan worker followed its existing GitHub auto-deployment configuration.

Live checks confirmed `/api/health` returns 200, anonymous admin access returns 404, and anonymous review-SMS access returns 401. The synthetic preview is blocked by the production guard and contains no fixture content (Next.js renders a streamed not-found response with noindex). The signed-in SimplAssist Reviews history and settings loaded successfully, retained the Google link and allowance/renewal details, and kept sending paused. No form save, preview email, or SMS was triggered by the browser checks.

### Owner-approved address correction

Live preflight found that SimplAssist's saved street field contained only a city description while its verified Telnyx brand held the full registered address. The owner explicitly approved keeping **both accounts' full addresses private**. A guarded, single-row update set SimplAssist's public visibility to `city_state` and copied the existing verified carrier street address privately at the same commit. EIN, legal name, city, state, ZIP, brand identity, owner, and current row revision were checked before the update.

This is the sole intentional change to the existing account's address settings. Fresh HTTP reads of its hosted contact, privacy, terms, and review-text pages contain neither the private street nor ZIP; the browser shows `South Bend, IN` on the contact page. Before/after fingerprints confirm that subscription, renewal, phone/resource bindings, and all 83 contacts remained unchanged. Telnyx still reports the verified existing brand with its two original campaigns.

### Remaining live pilot

The initial release left shared starts disabled and registration tables empty. The October 5 setup preparation below supersedes that initial state: the exact two memberships are now approved, and private owner-discount compatibility is deployed. Bryan's actual texting draft, hosted-page checks, paid activation, and carrier approval remain separate steps. The monthly add-on remains dependent on real carrier approval, verified assignment, and owner-confirmed activation. No live carrier submission or $35 → $49 carrier transition has been declared tested.

### Owner signup and deferred discount support — October 5, 2026

- The owner confirmed reaching the Bryan Develops dashboard and supplied a screenshot showing the account website as `bryandevelops.com`; subsequent read-only production and browser checks confirmed the active account. Do not ask the owner to create another account or reuse the deleted test account. Exact account identifiers and both owners' authorization must still be revalidated through the administrative workflow before enrollment.
- A private, single-redemption live Stripe promotion was created with 100% off forever, scoped to the existing recurring Chat, review-texting, and Growth/Full subscription products. The owner supplied a Checkout screenshot showing the Chat price reduced from $15 to $0. Keep the redeemable code and owner identifiers out of this document.
- The coupon excludes the $25 activation fee and usage overage products. Do not treat it as carrier approval, SMS entitlement, or a waiver of provider costs.
- Review-texting owner-discount compatibility is implemented in `54ceab6`, scoped by `REVIEW_SMS_OWNER_DISCOUNT_POLICY` to the exact business, owner, Stripe customer, subscription, and coupon. It validates the already-applied 100%-forever recurring discount, preserves it on the same subscription, and keeps the $25 activation separate. The later Growth conversion still rejects discounted subscriptions and needs its own compatibility work before that future upgrade. Do not remove the general discount guards or manually add items to bypass readiness checks.
- The owner initially deferred the discount adjustment while setting up the widget and reviews. The widget is now reported working; read-only production inspection and the live browser subsequently confirmed the fresh active Chat account, saved Google review link, verified Reply-To, one customer, and no review-texting account or conversion in progress. The owner has not asked to send an email review request. The dashboard's earlier texting invitation and explanation were deployed and verified in this account in commit `2495592`.
- Next setup order after the compatibility deployment: complete Bryan's approved shared-brand review-texting setup. The future Growth carrier transition is a separate step and is not required to begin the review-only application. Do not start registration, payment, or a real message merely because these notes were saved.

### Reminder for the future Bryan Develops Growth upgrade

The owner explicitly asked on October 5, 2026 to retain this reminder for a later conversation. **The core same-account, same-number $35 → $49 conversion is implemented; a real carrier transition has not been verified.** This is a controlled validation of the existing workflow, with fixes if needed, rather than an assumption that the whole upgrade still needs to be built. Do not promise that no additional implementation will be needed before an actual pilot succeeds.

Read the [conversion verification record](./review-texting-conversion-verification-2026-10-04.md) and [upgrade ladder release record](./upgrade-ladder-release-2026-10-04.md) alongside this reminder before resuming.

When the owner later requests Growth:

1. Re-inspect the fresh Bryan account's current subscription, discount, shared membership, approved campaign, messaging readiness, usage, number, and provider resource ownership. Keep the same account and phone number; do not create another subscription. The existing SimplAssist account, both of its campaigns, and the shared brand must remain protected.
2. Verify the approved owner discount survives both the review add-on and the Growth change, including a legitimately zero-dollar invoice. The standard conversion replaces the exact $15 Chat item plus $20 review item with the $49 Growth item on the same subscription. There is **no second activation fee**. Preserve the renewal date and original activation receipt; do not bypass readiness or remove discount guards for all customers.
3. Check shared-brand campaign capacity, then use the durable conversion to prepare one replacement **MIXED** campaign for review marketing and customer care. Reuse the existing verified brand, profile, and exact number. Keep the current review service available while approval is pending. A new messaging purpose does not expand any customer's saved consent automatically.
4. Wait for genuine carrier approval. Explain the possible interruption and obtain the owner's explicit **Move my number** confirmation for the chosen time. Respect the assignment lease and handoff fence; pause outbound SMS and SMS AI during the move while web chat, email reviews, inbound storage, opt-outs, and deferred review opt-ins continue.
5. Verify Telnyx reports that exact number assigned to the approved replacement, then check the atomic business/phone/review bindings and that the existing paid review service resumes. Only afterward offer the Growth billing quote. An uncertain provider response requires inspection/reconciliation, not another paid submission or a replacement number.
6. Verify the exact quote/invoice/operation, discount-adjusted amount, pending-payment behavior, and one-time application of the billing change. Remove only the exact review add-on. Preserve contacts, conversations, permissions, suppressions, renewal, and used/reserved SMS counters. Growth uses its existing 1,500-part period allowance, without an extra 250-part review bucket or a fresh usage period.
7. Before a live change, run relevant Stripe TEST and regression checks for failed payment/SCA, zero-dollar owner billing, cancellation, renewal, retries, and delayed webhooks. After a real successful transition, test both review texting and missed-call follow-up/booking or sign-up on the retained number using an explicitly authorized, consenting test recipient. Do not send to a real customer as an implicit test.
8. A failed or abandoned Growth payment may leave the account on its existing review-texting package using the new campaign. Resolve the exact pending invoice before another billing change. Preserve recovery and respect later cancellation/suspension. Retire only the verified detached old campaign through the scoped operation; do not enable general resource cleanup.
9. Keep broader conversion rollout gated until evidence supports enabling it. `REVIEW_SMS_UPGRADES_ENABLED=1` and `REVIEW_SMS_UPGRADES_PILOT_BUSINESS_IDS` control new review-to-Growth starts separately from first-time Chat texting and shared registration. Restrict any first pilot to the exact approved account; disabling new starts must not disable reconciliation of in-flight operations.

This reminder does not authorize a future upgrade, number move, carrier charge, or test message by itself. Act within the owner's request when resuming and inspect current state rather than treating October's observations as current. When explaining the status, distinguish **implemented logic**, **Stripe/application verification**, and **actual carrier pilot evidence**.

### Bryan review-texting setup preparation — October 5, 2026

The owner asked to start the Bryan review-texting setup. Fresh read-only checks confirmed the new Chat account, no existing review-SMS account or shared membership, and the original verified legal brand with its two campaigns. The existing owner coupon covers Chat and the review add-on; a live read-only Stripe preview returned $0 due without changing the subscription. Activation and overage products remain excluded.

- `b3e35ca` adds a small authenticated admin form on the exact admitted target business. It calls the existing read-only inspection and revisioned approval endpoint; actor identity comes from the admin session. It never uses the legacy brand attachment form for a shared member.
- `54ceab6` implements the private owner-discount policy, $0 display and verified invoice reconciliation. Durable proof survives JSONB ordering and disabled new-start configuration. Confirmed retries recover an exact existing invoice before considering any mutation; a missing or changed discount blocks an unsubmitted retry. Cancellation preserves the free base plan.
- Verification: over 8,200 application regressions passed; the one socket-bound regression was rerun outside the restrictive sandbox and passed. TypeScript, lint, and production build passed. Seven real Stripe TEST contracts and six actual application/database checks passed, including $25 Checkout creation/expiration, real $0 invoice and payment event, signed webhook replay, renewal, recovery, and cancellation. All disposable TEST resources were cleaned. Relevant database regressions passed 162 assertions without reset.
- Browser verification used an explicitly synthetic admin preview: read-only inspection, disabled approval until acknowledgement, keyboard approval, mobile 390px and dark mode. This is not evidence of real carrier approval.
- Private configuration contains exactly the two approved account identifiers, admissions enabled, paid starts disabled, and the exact owner policy. No cleanup or release controls were changed. No new database migration is required for these changes.
- This narrow owner path requires the subscription invoice to remain $0; it does not authorize an unexpected payable invoice or discount setup/overage purchases. No SMS, campaign filing, or live payment was performed by these verification steps.

Railway Web deployment `60c990ee-cf35-4396-901d-f0f37d31a777` reached **SUCCESS** for `54ceab6`, uploaded from a clean Git archive. Both implementation commits were pushed to `main`; unrelated working files were excluded. No additional migration or worker deployment was needed for these changes.

Using the owner's authenticated admin session, the exact fresh Bryan Develops account was inspected and approved through the revisioned admin form. The provider inspection confirmed the existing verified brand and two of five campaign slots occupied. Production rereads confirm SimplAssist's membership is `active`, Bryan's is `approved`, both revision 1, and both accounts use `city_state` public-address visibility. Bryan has not yet consumed its approval or bound provider resources. A before/after comparison confirmed SimplAssist's subscription, number, and provider bindings unchanged, with shared-brand SMS eligibility still true.

The real Bryan owner session displays the shared Arambula Ventures LLC registration, locked legal fields, $0 monthly owner price, and separate $25 activation. The owner subsequently confirmed and checked the registration/Terms agreement. The normal owner UI saved representative details, preferred number `+15746679002`, and a `hosted_keyword` draft. Selection is not a number purchase or reservation. The generated hosted slug is `arambula-ventures-llc-95b46094`; the public pages are branded **Bryan Develops**, operated by Arambula Ventures LLC.

All four anonymous hosted pages returned 200 and omitted the private street and ZIP from full HTML, including page data. The review-text permission page correctly says signup is not ready and no permission is collected; it exposes no `sms:` link before provisioning. No Checkout, live payment, carrier submission, or message was created. New shared paid starts remain disabled.

Draft saving produced an internal `blocked` website-screening result for `708_lead_gen_seo_affiliate`. This is **not a Telnyx rejection**. Stored homepage evidence is “Lead generation and consultation booking.” and “Custom-built SEO workflow software for audits, rank tracking,”. A fresh direct HTTP read (the search cache was outdated) confirmed both snippets belong to **Portfolio → My Work** cards, respectively Brilliant Solar Solutions and simplSEO. The current Services section lists Web Design, App & Software Development, Technical Support, WP Maintenance, and Branding. The cards are not explicitly labeled historical/retired; the owner's earlier statement supplies simplSEO's retired status. Do not claim this distinction guarantees carrier acceptance.

An explanatory note has been prepared, but not submitted, in the existing authenticated admin risk-review form. That form requires explicit acknowledgment of carrier rejection/review-fee risk; the owner was asked to authorize internal review approval while retaining the site as-is. Findings remain preserved. At this stopping point the risk acknowledgment is unchecked and status remains blocked. Resume with that response, recheck the current account/site and input hash, and use the supported admin review if authorized. Then enable paid starts only for the existing exact two-account pilot and use the normal $25 activation flow. Do not bypass the guard by directly editing risk fields or create a parallel Telnyx campaign. The separate future Growth checklist above remains required.
