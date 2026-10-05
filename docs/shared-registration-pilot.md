# Shared legal registration pilot

Status: implementation and local verification complete; **production enrollment and final release validation are pending**. No new live brand, campaign, number, subscription, or customer message was created by this verification.

## Scope and baseline

The pilot allows two approved business accounts under the same legal company to share one verified Telnyx brand. Each account keeps its own owner authorization, website, profile, number, campaign, customers, review permissions, quota, billing, and lifecycle. Other accounts retain the existing registration flow.

Known production baseline, last inspected before enrollment:

- Existing SimplAssist business: `ea848911-ef72-44a6-8cf3-c47b3959be26`.
- Existing brand: public TCR `BL69PDP`; Telnyx internal ID `4b20019d-e93e-d697-b8ee-c6233e9bf533`.
- Existing SimplAssist campaign: `4b30019f-8814-cb6c-1e77-950fa70e0410`; the provider brand already has two campaigns. Preserve both.
- Old deleted Bryan account: `aa30a10e-13c1-4c9b-b9d5-6804cf01e6cb`. It is excluded from this pilot and must not be revived or reused.
- Fresh Bryan Develops account and its owner ID: not yet supplied. There is no approved target membership yet.

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

## Release validation — pending final release

Production preflight on October 5 confirmed migration history through 115; the dry-run includes only 116 and 117, without seeds or vault changes. The shared admission, paid-start, and business allowlist variables are unset (disabled). Generic resource release remains `disabled`; review SMS release remains `0`. SimplAssist retains its active Full subscription, October 22 renewal, 83 contacts, original phone/resource bindings, and the verified Telnyx brand with two campaigns. No target enrollment exists yet.

Record the final clean database/application suite, deployment/version, environment controls, authenticated browser checks, and read-only production verification here. After the fresh target exists, separately record its approved membership and the owner-authorized live pilot results without sensitive identity data.
