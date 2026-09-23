# Plan-first onboarding, payment last

## Customer flow

After account creation and email confirmation, an eligible new direct customer
chooses a plan before entering business information. Selection saves only
`onboarding_selected_plan`; it does not create a Stripe customer, checkout,
subscription, payment, or Telnyx resource. No plan is selected automatically.

Chat Only follows the existing business information, hours, assistant knowledge,
AI settings, and review path. Texting plans retain their additional verification,
SMS compliance, phone selection, and post-payment carrier review. The final
review action opens Stripe; payment is confirmed in Stripe.

Each step still saves on Continue. Leaving and returning resumes from persisted
data. Changing a plan before checkout retains common setup and requires any newly
applicable SMS steps. This change does not add draft autosave or carry a public
pricing-page choice through signup.

## Server policy and compatibility

`planSelection.position` is derived, not stored:

- `start`: eligible direct acquisition without a subscription, durable family
  lock, provider history, completion marker, or protected billing override.
- `after_knowledge`: an existing eligible selection flow, including legacy SMS
  accounts that still need to save an exact intent for checkout recovery.
- `null`: no editable direct selection flow.

An unfinished, unlocked account with no intent chooses once and then resumes its
saved setup. Existing subscription and partner authority remain authoritative.
Existing Chat acquisition flags and price readiness gates remain in force.
Disabling acquisition never converts a saved Chat choice into an SMS choice.

The read-only checkout context reuses the onboarding readiness calculation.
Fresh, unclaimed direct acquisition must use onboarding checkout, reach
`review_submit`, and match its saved plan when early selection is enabled.
Incomplete setup returns `409 onboarding_incomplete`; a billing-mode bypass
returns `409 onboarding_checkout_required`, both with current state. No checkout
or family claim is created by these rejected requests.

Existing family-locked attempts and paid finalization retain their established
session identity, retry, webhook, and recovery behavior. Beginning checkout
still claims the Chat/SMS family before payment. Canceling checkout does not
unlock cross-family switching. Such changes require support. Existing SMS-tier
operation conflicts also remain enforced.

SMS history hides Chat Only from the legacy selector and is checked again by the
selection endpoint. The existing atomic intent writer remains the authority for
concurrent family claims; it is not replaced by a client-side check.

## Verification and release

Verify first selection, both step sequences, persisted resume, plan changes,
review Edit targets, each missing checkout prerequisite, and crafted billing-mode
requests. Cover legacy SMS intent restoration, provider and subscription states,
availability rollback, repeat checkout requests, cancellation, lost browser
return, and repeated finalization. Read-only validation must not synchronize
progress or perform Telnyx provisioning.

Run affected and full Vitest suites, TypeScript, lint, the production build, and
browser checks. Payment checks use disposable fixtures and Stripe test mode;
production customer records and Telnyx provisioning are outside verification.

Deploy the complete reviewed application release together. This change has no
database migration or new environment variable. Before production release,
record the preceding deployment as the rollback target. If rollback is needed,
restore that application version without resetting saved intent, onboarding
data, checkout operations, family locks, or Chat Only sales configuration. The
previous application already understands the stored plan and step identifiers.
Production deployment is separate from implementation and local verification.

### Implementation verification

The implementation passed the repository Vitest suite (420 files, 7,119 tests),
`tsc --noEmit --incremental false`, ESLint, and the optimized Next.js build.
The suite command excludes archived local copies so each current test runs once:

```sh
./node_modules/.bin/vitest run --exclude '.worktrees/**' --exclude '.claude/**'
```

Browser verification used disposable local accounts and a server egress guard
allowing only loopback and Stripe. It confirmed an initially empty plan choice,
no checkout/subscription from selecting, Chat's six-step path, saved-plan reload,
Business Info Back, Chat-to-SMS-to-Chat switching with retained common facts,
all four common review Edit targets, and mobile layout at 390px. The SMS fixture
reached review with its verification, use-case, and phone sections and did not
start payment or provider work.

Stripe test mode confirmed one $10 Chat checkout without a setup fee.
Canceling and retrying reused the same session. After a successful test-card
payment, the browser tab was closed before app finalization; delivery of the
real test completion event activated Chat Only and completed onboarding with
one completed attempt. Replaying the event returned a duplicate acknowledgement.

The initial local database was at schema 080 and lacked existing voice-billing
functions used by subscription synchronization. Recovery was verified against
the fully migrated local schema 090 using only the disposable fixture rows and
the same test payment. This required no application workaround or schema change.

Common and SMS setup facts were seeded for the browser navigation checks; the
automated tests exercise missing persisted prerequisites. Webhook verification
used a signed local replay of the real Stripe test event, not hosted delivery.
Afterward, the test subscription was canceled, its customer deleted, and the
created product/price archived. Both local copies of the disposable fixtures
were removed and verified absent. The temporary server/browsers were stopped
and credential files removed.
