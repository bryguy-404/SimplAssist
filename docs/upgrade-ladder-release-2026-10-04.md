# SimplAssist upgrade ladder

The acquisition path is Chat ($15), optional Chat review texting ($20 extra,
$35 total), SMS + Web Chat ($49), and Full Suite ($79). New texting activation
costs $25. SMS Only ($29) remains supported but is omitted from the default
public acquisition list. Existing subscriptions are not repriced.

## Release controls

- `REVIEW_SMS_UPGRADES_ENABLED=1` together with
  `REVIEW_SMS_UPGRADES_PILOT_BUSINESS_IDS` permits new $35-to-$49 conversions.
  Leave this disabled until an eligible, owner-approved real carrier pilot
  passes. Disabling acquisition does not disable recovery of committed work.
- `DASHBOARD_UPGRADE_PROMPTS_ENABLED=1` enables the read-only dashboard resolver.
  Each offer also checks that its destination is available. A disabled carrier
  conversion suppresses the missed-call offer without suppressing independent
  email-to-review-texting or Growth-to-Full destinations.
- Preserve `CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS` and all existing partner,
  suspension, cancellation and account-ownership checks.
- `TELNYX_REMOTE_RELEASE_ENABLED` and general release configuration remain
  disabled. This release does not enable general canceled-number cleanup.

## Deployment order

1. Inventory existing Stripe-bound database operations and provider release
   state read-only. Deploy historical activation receipt/refund compatibility
   while the current $49 configuration remains in effect.
2. Preserve historical activation prices. Switch new activation configuration
   to the already-existing active $25 one-time price only with the $25-aware
   application. Expiration of an old open Checkout must be confirmed at Stripe
   before another payment is created.
3. Apply additive migrations 112–115. Deploy conversion code with new starts
   disabled. Never edit previously applied migrations or reset production.
4. Verify protected/shared provider identifiers and run an owner-approved real
   carrier pilot before enabling the conversion offer. Keep recovery running
   if new starts must be disabled.

## Payment and provider invariants

Original activation operations retain their Price, amount and payment identity.
A completed $49 activation remains valid and an eligible refund returns its
original amount. Unknown payment outcomes are reconciled rather than replaced.

Review-SMS conversions bind the exact paid Chat subscription, review add-on,
original activation and owned resources. A separate MIXED campaign is submitted
once. Existing reviews continue while approval is pending. The owner chooses
when to move the number. During the carrier handoff, outbound SMS and SMS AI
are fenced; website chat, email reviews, inbound storage and opt-outs continue.
Deferred review opt-in confirmations retain their purpose and resume only when
the assignment is verified safe.

A final Stripe preview becomes available after exact number assignment is
verified and local bindings are updated atomically. One pending-payment update
replaces the $15 item with $49 and removes the exact $20 item. The renewal date
and all used/reserved usage survive. The final allowance is 1,500 shared SMS
parts, without another 250-part review allowance. Exact invoice evidence drives
completion; a late payment does not undo cancellation or suspension.

The only new destructive operation can retire the old detached campaign after
the replacement assignment and ownership are verified. It cannot delete the
retained phone number, brand, messaging profile or voice application. Unknown
provider mutations remain held for inspection rather than being retried as
another paid submission.

## Initial production inventory

Read-only inventory on 2026-10-05 UTC found no review-SMS accounts, review-SMS
billing operations or Chat-upgrade conversions. The one existing active Full
subscription and its applied operation are unchanged. General provider release
mode is `disabled`; its two existing release actions are held/retained.

Stripe's existing one-time $25 price is `price_1TrLaPAfcT8kDgBUEyHmAHGl`.
Historical $49 prices `price_1UMOtJAfcT8kDgBUWF1SkFHj` and
`price_1UMOtKAfcT8kDgBUD3boxslk` must remain available for receipt recovery.

## Verification status

The final integrated application passed 8,063 tests across 492 files. Three opt-in
provider suites are excluded from the ordinary run. Separately, the conversion
and payment-contract harnesses were run with explicit Stripe TEST configuration.
TypeScript, ESLint, the production build,
and the review-worker TypeScript build passed.

The guarded local database harness replayed all migrations and passed 4,193
assertions across 106 files, with privilege and fixture-cleanup checks. Further
focused conversion cleanup coverage passed 46 assertions. The provider suite
passed 54 assertions, including exact binding, submission and handoff fences,
and multi-day consent recovery. The preference suite covers revision conflicts,
snooze duration, permanent hiding and tenant isolation.

The historical compatibility deployment was committed as `1fe12b8` and verified
healthy on the web app (`b2724159-e0fd-429f-b437-9b507d74c5e0`) and review worker
(`fc88133f-83be-4230-aacb-d54c0ddf75f6`) before the fee switch. The independent
$25 fee correction is `c329fda`, deployed successfully to the web app as
`bfc668b8-05ee-405d-9c7b-06eb2bd6b6b3`. A failed initial upload never replaced
the running application; a clean committed archive was used for the retry.

No live customer charge, fabricated carrier approval or live message is an
acceptable substitute for a real carrier pilot.

Real Stripe TEST verification passed nine conversion checkpoints and eight
activation/add-on API-contract checks, with zero cleanup errors. SCA recovery
used a valid replacement payment method on the exact `requires_action` invoice;
no browser 3DS challenge was automated. The activation contract verified a $25
Checkout amount and a separate real $25 PaymentIntent/refund, rather than
completing hosted activation Checkout. Detailed evidence and reproducibility
requirements are in `review-texting-conversion-verification-2026-10-04.md`.

Production migrations 112–115 applied successfully. A post-migration inventory
confirmed the subscription, SMS operation, review controls/exclusions, general
release configuration and existing release actions are byte-for-byte unchanged
in the selected inventory fields. Both newly added workflow/preference tables
are empty; no live conversion was started.

## Deployed release and remaining gates

The five implementation diffs were committed independently: fee correction
`c329fda`, acquisition/source identity `23c96bc`, provider handoff `a6cb570`,
conversion billing `daa7d8b`, and dashboard suggestions `3ba46d9`. All were pushed
to `main`. The integrated release deployed successfully to the web application
(`d77083e2-9572-4605-8b80-b1a0d6d86bed`) and review worker
(`918e8bf6-4f56-496b-8114-669efb270f48`). The public health endpoint returned 200;
bounded deployment logs showed no application errors.

Both services use the existing $25 activation Price for new setup and review
texting. Monthly catalog prices and existing subscriptions were not changed.
Production migrations 112–115 are already applied; no manual SQL is required.

A final independent billing check (commit `382f3a2`) found that an unrelated pending invoice item
could enter Stripe's preview. The follow-up fix validates the exact three
proration lines before both quoting and confirming payment, and rejects
unsupported tax/credit adjustments before any charge. It passed 94 focused
tests, four real Stripe TEST preview checks, TypeScript, ESLint and a production
build. Its test resources were cleaned up without errors.

The final code commit `382f3a2` was pushed and deployed successfully to the web
app (`df4b7c98-3a31-4329-909a-fcf1358b5abb`) and review worker
(`41f6d437-6f43-448b-aefa-e5db26908284`). Final health returned HTTP 200; bounded
error-log reads contained only npm's configuration warning. A final full test
run passed all 8,063 ordinary application tests. Three external-provider
harnesses remained opt-in in that run; their separate executed evidence and
limitations are described above.

`REVIEW_SMS_UPGRADES_ENABLED=0` and `DASHBOARD_UPGRADE_PROMPTS_ENABLED=0` remain
set in production. The provider pilot still needs an eligible, owner-approved
Chat account with paid review texting and verified protected/shared provider
identifiers. Production inventory contains no eligible source account. Browser
acceptance must also finish before enabling dashboard promotions; automated
tests and synthetic provider fixtures do not substitute for the real pilot.

Authenticated dashboard/API/database verification passed actual snooze,
permanent-hide and revision-conflict requests, with no billing/provider side
effects. Desktop browser checks covered the public pricing presentation and
approved number-move acknowledgement. Native browser controls then became
unavailable, leaving mobile, remaining wizard states and interactive navigation
acceptance unfinished. See `upgrade-ladder-browser-verification-2026-10-04.md`.

The disabled start/promotion switches do not stop reconciliation of existing
payments or number handoffs. General provider cleanup remains disabled and
excluded partner accounts remain excluded.
