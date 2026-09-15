# Pricing, Packaging, and Feature Roadmap

Decision record for SimplAssist's initial pricing, tier positioning, feature
entitlements, and post-launch validation plan.

Last updated: September 14, 2026

## Voice product decision — September 14, 2026

Live AI phone answering is planned exclusively for Pro / Full Suite. Growth at
$45 retains its existing text and web-chat capabilities. Build and test voice
on SimplAssist's existing internal account and number first, then complete
voice contact collection and calendar booking, and prepare the customer rollout.

Before general release, add top-tier server-side access control, a choice of
text follow-up or AI voice as the primary missed-call response, a monthly voice
minute allowance, usage visibility, and limit handling. Set the allowance and
any opted-in extra-usage price using measured pilot costs. Existing subscription
prices are unchanged by this decision; no voice allowance quantity is set yet.

The [voice implementation blueprint](voice-ai-implementation-blueprint.md)
records the phases, duplicate-response prevention, proposed text fallback, and
commercial launch requirements. These are roadmap decisions, not shipped features.

## Current decision

Add a self-serve website-receptionist entry tier at:

- Chat Only: **$10/month** with 200 completed web-chat AI replies per month

Keep the founding/test-user SMS plan prices at:

- Starter / SMS Only: **$25/month** with 500 included SMS parts
- Growth / SMS + Web Chat: **$45/month** with 1,500 included SMS parts
- Pro / Full Suite: **$65/month** with 2,500 included SMS parts

These prices are intentionally accessible while SimplAssist recruits its first
paying users and learns how they use the product. They are validation prices,
not a promise that future customers will always receive the same pricing.
Early customers may be grandfathered when public pricing changes.

Do not raise prices based only on estimates. Revisit pricing after 5-10 paying
businesses have produced at least one or two useful billing periods of real
usage, cost, retention, and support data. A possible future starting point is
$29 / $49 / $79, but the evidence should determine the final prices.

## Tier positioning

Each tier should sell a clear business outcome:

1. **Chat Only:** Answer website visitors, capture leads, and book appointments
   without phone/SMS registration.
2. **Starter:** Respond to missed calls.
3. **Growth:** Capture leads from calls and websites, then turn them into booked
   appointments.
4. **Full Suite:** Measure performance, automate follow-up, and generate more
   repeat business and reviews.

Growth is the intended "Most Popular" plan. Google Calendar connection and AI
direct appointment booking belong in Growth because they complete the journey
from lead capture to a booked appointment. Calendar should not be held in Full
Suite merely to make the highest tier look larger.

## Approved package matrix

### Chat Only — $10/month

For a business that wants an AI website receptionist without texting.

- Website chat widget
- 200 completed AI replies per billing period
- Web-chat lead capture
- Contact and conversation inbox
- AI answer, tone, FAQ, and service customization
- Google Calendar connection
- AI direct appointment scheduling
- No phone number, A2P registration, SMS, MMS, or Telnyx activation

### Starter / SMS Only — $25/month

For a small business that primarily wants dependable missed-call coverage.

- One local SimplAssist phone number
- Manual SMS inbox and replies
- Automatic compliant missed-call text
- Contact management and conversation history
- 500 included SMS parts per month

### Growth / SMS + Web Chat — $45/month

For a business that wants to capture and book more leads.

- Everything in Starter
- Full AI SMS conversations
- Website chat widget
- Web-chat lead capture
- Custom widget branding
- AI answer, tone, FAQ, and service customization
- Google Calendar connection
- AI direct appointment scheduling
- 1,500 included SMS parts per month

### Pro / Full Suite — $65/month

For a growing business that wants performance insight and follow-up automation.

- Everything in Growth
- Advanced AI guardrails
- Advanced analytics dashboard
- Lead-to-appointment conversion reporting
- Weekly performance summary
- Real-time new-lead alerts
- Review-request workflow
- Automated follow-up and no-show workflows
- Priority support
- 2,500 included SMS parts per month

## Product boundaries

All customers should retain basic operational visibility into their own data:
conversations, contacts, appointments, and SMS usage. Full Suite should unlock
deeper trends, funnel reporting, summaries, alerts, and automation rather than
charging customers merely to see their basic records.

Google Calendar's default reminders are sufficient for the initial booking
experience. They avoid building native reminder scheduling immediately.
SimplAssist may later add branded SMS reminders when control over delivery time,
wording, status, and follow-up becomes valuable.

Google Calendar does not reliably prove whether a customer attended an
appointment. No-show reporting and automation will eventually require a
SimplAssist appointment outcome such as completed, canceled, or no-show, a
manual business action, or a future scheduling/POS integration.

Review requests must not be treated as unrestricted outbound messaging. Before
shipping them, confirm that the recipient consent, campaign registration,
message content, sender identification, opt-out behavior, and audit trail cover
the review-request use case.

## Implementation truth as of this decision

- Server-enforced feature walls now use an explicit per-plan capability matrix,
  not a ranked minimum-plan ladder. Chat Only and Starter are intentionally
  incomparable: Chat Only has web chat and Calendar but no SMS capability;
  Starter has missed-call/manual SMS but no AI chat. Existing Starter, Growth,
  and Full feature vectors remain unchanged.
- The application catalog and local migration 057 recognize Chat Only at
  $10/month, zero SMS parts, and 200 AI replies. Local Phase 2 code and
  migrations 058–059 add a default-off direct Stripe purchase path, simplified
  no-SMS onboarding, atomic paid completion, plan-aware dashboard, and durable
  cross-family transition guard. No hosted Chat Only Stripe Price or migration
  has been created/applied, both acquisition switches remain off, partner
  selection remains hidden, and no AI-reply meter is active yet.
- Plan-specific SMS allowances are enforced at 500 / 1,500 / 2,500 parts.
- Active, trialing, and past-due subscriptions retain their selected plan;
  canceled and normalized unpaid subscriptions stop paid execution without
  deleting customer data.
- The 80% usage threshold is recorded and displayed on the Billing page, but no
  proactive warning email or SMS is sent.
- Overage opt-in permits continued sending and records usage, but the $0.03 per
  extra part is not yet submitted to Stripe for automatic billing.
- Google Calendar connection and AI direct appointment scheduling are built.
- Advanced AI guardrails are built and execute only for Full Suite.
- Review requests, weekly performance emails, advanced conversion analytics,
  new-lead alerts, and automated no-show/follow-up workflows remain roadmap
  capabilities. Their Full-only entitlement keys are reserved now, but no
  placeholder implementation is exposed.

The public pricing cards show the approved destination package. The entitlement
system and roadmap features must be completed before broad public selling.

## Deferred engineering notes

- The 80% usage warning is stored and displayed, but it does not proactively
  send an email or SMS.
- The $0.03 overage rate is represented in product/billing logic, but overage
  usage is not submitted to Stripe for collection.
- Customer self-service overage opt-in does not exist; only the internal admin
  route can change it.
- Stripe plan synchronization currently assumes the first subscription item is
  the base-plan Price. Revisit that assumption before adding a metered item.
- Separate security backlog remains for owner hard-delete behavior and the
  broadly permissioned widget-logo storage surface.
- Before production rollout, confirm Stripe Revenue Recovery eventually moves
  exhausted subscriptions from `past_due` to `canceled` or `unpaid` rather than
  leaving them in recovery indefinitely.

## Recommended delivery order

1. ~~Build a shared, server-enforced entitlement system with stable feature keys.~~
2. ~~Apply the matrix to backend routes and dashboard locked states.~~
3. Instrument feature activation, locked-feature interest, usage, and upgrades.
4. Build the Full Suite analytics event model and conversion reporting.
5. Add real-time new-lead alerts and the weekly performance summary.
6. Add review requests after messaging-consent and campaign requirements are
   settled.
7. Add appointment outcomes, then follow-up and no-show automations.
8. Complete proactive usage warnings and actual Stripe overage billing.

The entitlement mechanism must be separate from the package policy. Moving a
feature between tiers should require changing a central matrix, not rewriting
every feature route.

## Evidence to collect from founding customers

Measure behavior instead of asking customers which features they would prefer
to receive cheaply:

- Plan selected and reason for choosing it
- Widget installation and activation
- Google Calendar connection and bookings created
- SMS parts, AI usage, and provider cost by account
- Lead volume by SMS and web chat
- Conversation-to-appointment conversion
- Locked-feature views and upgrade attempts after walls exist
- Support time, refunds, failed payments, and operational burden by tier
- Retention, cancellations, and upgrade/downgrade behavior
- Value of an average booked customer to each business

Useful discovery questions focus on the customer's existing workflow: what
happens after a missed call, how appointments are booked today, how often leads
are lost, what a booked job is worth, and which outcome would justify upgrading.

## Pricing review trigger

After meaningful founding-customer data exists, calculate contribution margin
and retention by tier. Include SMS parts in both directions, carrier fees,
Telnyx number and campaign costs, AI tokens, Stripe fees, email delivery,
support time, refunds, and any included manual service.

If the complete Growth experience consistently produces booked appointments,
test a public price around $49-$59. When Full Suite delivers analytics, reviews,
summaries, and follow-up automation, test a public price around $79-$99. Keep or
adjust Starter based on its acquisition value, support burden, margin, and
upgrade rate rather than its absolute profit alone.
