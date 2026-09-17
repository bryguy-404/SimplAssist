# Full Suite public launch — approved implementation

Approved by Bryan on September 17, 2026. Baseline `9aed12a`; branch `codex/full-suite-launch`. Six independently reviewable implementation commits, then release evidence. Preserve the other worktrees and unrelated changes. Use private Railway source uploads; do not push the public GitHub remote.

## Package and decisions

- $65/month, all existing Growth features, 2,500 SMS parts per subscription month, 100 voice minutes per subscription month, and implemented custom AI guardrails.
- Remove unfinished analytics, conversion reports, weekly summaries, lead alerts, reviews, follow-up/no-show automation and priority-support promises. No optional premium feature build.
- Preserve the accepted Marin voice, English, tone, signup/confirmation behavior. Signup and booking accounts use their respective goals/settings.
- New subscribers choose Text or Voice; default Text until the owner chooses Voice. Optional eligible text fallback; requested signup texts are separate from missed-call fallback.
- Immediate upgrades only after confirmed payment, showing the prorated amount first. Keep renewal date, grant proportional voice for the remainder, and retain used SMS while raising that cycle's total cap to 2,500. Downgrades take effect at renewal.
- $25 setup fee once per business, including returning subscriptions; preserve verified fee fulfillment.
- Public opening in Marin identifies business, AI and recording before recording/transcript persistence. Brief example: “Hi, thanks for calling [Business]. I'm the AI assistant, and this call will be recorded.” Then “How can I help you today?”
- Exclude ringing/setup/disclosure from customer minutes. Preserve 30-day audio retention and protected playback.
- Two concurrent calls per business, four across the worker after load verification. No paid voice overages or automatic extra-minute purchases.
- Bryan upgrades through the ordinary purchase flow himself. A confirmed upgrade permanently retires his private tester exception while retaining selected Voice mode, number, history and old pilot accounting. No automatic charge or subscription change during development/deployment.
- No private-access cohort. After release, Bryan's friend purchases normally and completes onboarding/calendar connection for the real booking/invitation test.

## Phases

1. **Accurate package:** shared catalog, homepage/comparison, onboarding/billing prompts, waitlist/launch templates; future capabilities unavailable. Sales remain closed. Do not send launch emails.
2. **Billing:** durable single-operation checkout/upgrade/rejoin; server-bound customer/subscription/item/prices, preview+confirmation, payment-gated upgrades, source replacement, scheduled downgrade, once-only setup fee, webhook/status recovery. Preserve unrelated Chat Only acquisition and existing SMS overage settings.
3. **Commercial voice:** verified paid-account enrollment without manual business membership; settings/readiness; permanent pilot retirement; emergency controls; exact monthly accounting and shared capacity; commercial booking permissions.
4. **Public opening:** bounded pre-recording media phase; actual notice playback proof; start recording, activate conversation and meter handoff; interruption/refusal/failure handling; accurate privacy/service descriptions.
5. **Booking:** reuse existing availability, confirmation, contact, booking/request and provider recovery; revalidate authority immediately before provider submission; correct confirmed-email invitations and isolation.
6. **Release:** full relevant tests/builds, independent sensitive-change review, browser walkthrough, independently verified migrations/private deployment; public greeting and recording check on existing approved caller; price/cost/capacity verification, then open Full purchases and public eligibility.

## Interfaces and invariants

- Authenticated billing preview/confirmation accepts supported plan enums, not arbitrary client price/subscription identities. Persist operation identity, source fingerprint, expiry, payment evidence and provider idempotency keys; uncertain provider outcomes never create fresh payable work.
- Additive schema only. Payment-confirmed canonical billing synchronization creates at most one allowance per period; old subscription events cannot regain authority. Use original effective payment time, not recovery time.
- Extend existing voice owner response with actionable readiness; maintain revision checks. Keep historical access under current account rules.
- Permanent pilot retirement is monotonic. Old pilot callbacks and accounting drain safely; downgrade cannot revive private disclosure bypass.
- Disclosure requires complete output and current-stream playback proof. Before completion: no recording, persistent caller fragments, business answers or actions. One interrupted-notice retry; refusal closes without introducing unrecorded conversation mode.
- Old active-call uncertainty retains existing recovery rules. A proven disclosure-only call can settle zero only after verified phone termination.
- Calendar authority must still be current at provider submission. Uncertain appointment result never means confirmed; an appointment request is not a booking.

## Verification and launch gates

Use mocked action providers and Stripe test mode for automated verification. Cover duplicate/uncertain checkout, failed/paid upgrades, proration/renewal/downgrade/rejoin, setup fee, old webhooks, account isolation, pilot retirement, 4-call capacity and overflow, minutes/failures/cleanup, disclosure/refusal/recording/access, one signup text/usage/Lead, booking correction/concurrency/recovery/invitations. Run application and isolated database suites, app/worker types, production build, desktop/mobile walkthrough and independent billing/access review (two rounds for deletion).

Before opening checkout: package matches behavior; purchases/charges/access and voice limits pass; public greeting and protected playback verified; booking integration tests pass; no duplicate charges/texts, cross-business disclosure or false booking success; operational cost headroom is reported without changing approved pricing. Keep gates closed if required evidence is missing. Friend's real booking/invitation remains explicit post-launch live verification.

Rollback closes new sales/admissions, safely drains calls and retains paid subscriptions, records/accounting. Never resend texts, reset minutes, or restore retired pilot exceptions.
