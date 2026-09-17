# Full Suite public launch — implementation and verification

Approved scope: [implementation plan](full-suite-public-launch-plan.md). Baseline `9aed12a`, branch `codex/full-suite-launch`.

## Current status

Implementation in progress. Full Suite sales remain closed. No production migration, application deployment, subscription change, public voice activation, or launch email has been performed for this batch.

## Phase 1 — package and capability catalog

- Full Suite presents $65, 2,500 SMS parts, 100 voice minutes, existing Growth features and custom AI guardrails. Homepage/comparison, preview-home content and waitlist/email templates share the agreed package. Long-message parts and voice limit behavior are explained.
- Reserved future capabilities grant no access and no longer produce an upgrade recommendation. Their identifiers remain available for future implementation.
- Homepage pricing FAQ responds to the existing sales gate; changing that gate later will not leave a stale “cannot be purchased” claim.
- Relevant catalog, entitlement, onboarding, homepage and mocked-email checks: **10 files / 209 tests passed**. This is not a production or browser verification.

## Pending release evidence

Billing operations/Stripe test mode; commercial eligibility/accounting and retirement; public disclosure and capacity; booking; complete app/database suites; app/worker types/build; independent sensitive-change review; desktop/mobile walkthrough; independently verified production schema/deployments; public greeting and protected playback acceptance; cost headroom; final sales activation.

Do not mark the release complete until the required evidence is recorded. Friend's first actual booking/invitation is the agreed post-launch live verification.
