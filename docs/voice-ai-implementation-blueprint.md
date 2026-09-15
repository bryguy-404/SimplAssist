# Voice AI implementation blueprint

Decision record: September 14, 2026.

Status: planning decisions for the upcoming implementation plan. Voice has not
been implemented or enabled by this document. The pilot uses SimplAssist's
existing internal business account and phone number, including the number
already shown on the homepage; a new number or second onboarding is not required.

## Agreed product destination

- Growth / the $45 tier keeps its existing text and web-chat capabilities. Live
  AI phone answering belongs exclusively in Pro / Full Suite, the top tier.
- The eventual voice product should answer business questions, collect and
  confirm caller details such as name and email, and book into the business's
  connected calendar when its settings permit direct booking.
- Voice and text use the same business-specific approved knowledge: FAQs,
  active services and prices, hours, contact details, business overview, facts,
  policies, and applicable owner rules. Owners maintain this information once.
- Preserve the distinction between an appointment request for owner review and
  a confirmed calendar booking. Announce completion only after the action succeeds.
- Test voice quality, answer accuracy, successful tasks, and operating cost
  before broad release. The first callable milestone is business Q&A.

## Delivery structure

Use one implementation blueprint for the full product journey. Divide each
implementation stage into separate reviewable commits/diffs with relevant
checks on one feature branch. Define acceptance criteria and dependencies for
each phase; an individual phase need not be independently usable by customers.

### Stage 1: Build and verify the internal pilot

1. Share the business knowledge and answering logic between text and voice.
   Adapt channel-specific behavior and preserve existing SMS/web-chat behavior.
2. Implement GPT-Live conversation handling and backend integration, including
   transcript context, interruptions, corrections, and result handling.
3. Connect the existing internal SimplAssist number using the selected Telnyx
   transport and route only the explicitly enabled pilot account to voice.
4. Add call records, error visibility, fallback handling, per-call usage and
   cost tracking, test spending limits, and reliable session termination.
5. Verify real phone calls end to end and the existing text behavior. The
   deliverable is a working number the owner can call for hands-on evaluation.

Resolve live deployment/version, OpenAI access, Telnyx routing, and persistent
connection hosting during implementation planning. The newer approved-knowledge
code was found in the richer-scan checkout; confirm the deployed version and
correct implementation base before extracting shared logic. The existing text
engine uses Claude; GPT-Live client delegation is a candidate for reusing it.

Establish server-side access control and a narrowly scoped pilot enablement
mechanism from the start. Keep normal account operational controls in force.
Public voice access, customer billing, and general rollout remain later work.

### Stage 2: Test, improve, and complete voice actions

- Compare spoken and text answers to the same business questions, including
  missing information, changed prices, caller corrections, and interruptions.
- Use actual call results and owner feedback to improve naturalness, latency,
  accuracy, and recovery from failure. Do not promise that every voice meets
  the desired quality before listening to real phone calls.
- Add separately testable phases for saving confirmed caller details and
  calendar booking. Clarify/read back spoken emails and appointment details.
- Verify actual saved contacts and calendar events, unavailable slots, tool
  failures, interrupted/corrected requests, and duplicate-event protection.
- Measure cost per call, per minute, and per successful outcome, including
  retries and failed calls. Keep voice, backend AI, phone, and hosting costs
  distinguishable. Test until agreed readiness criteria are met.

### Stage 3: Package, gate, and release to other businesses

- Enforce top-tier entitlement on the server for enabling voice and starting
  calls; hiding a setting alone is insufficient. Cover downgrade, cancellation,
  suspension, concurrent calls, and stale configuration.
- Provide the primary missed-call handling choice described below.
- Include a monthly allowance of voice minutes in the top tier. Choose the
  allowance and any extra-usage price from measured pilot costs; no specific
  allowance, new subscription price, or unlimited usage has been approved.
- Implement usage visibility, approaching-limit warnings, and an explicit
  limit-reached behavior. Any paid extra usage should be clearly priced and
  opted into before being charged; optional extra usage is the recommendation.
- Track billable voice seconds reliably and exactly once. Define the billing
  period, proration, concurrency reservations, and overage collection in the
  detailed plan before launch. Voice usage remains distinct from SMS parts.
- Validate business isolation, simultaneous calls, fallback behavior, billing,
  customer controls, and margins. Introduce a small customer group before
  broader release. Publish only capabilities that have passed verification.

## Primary response choice: text or voice

Requested product direction: top-tier businesses can choose one primary
response for calls the business does not answer:

- **Text follow-up:** use the existing missed-call flow and send the missed-call
  SMS when eligible.
- **AI voice answering:** pick up and converse with the caller while they are
  still on the line. After a successfully handled voice call, suppress the
  generic missed-call SMS for that same call.

Voice cannot speak to a caller after they have hung up. Preserve the existing
owner-forwarding choice and define its timeout/handoff into the selected mode.
Snapshot the selected route for a call so changing settings or retrying a
webhook cannot cause both primary flows to run. Treat a voice session starting
as distinct from successful handling of the caller's request.

This choice applies to missed-call handling. Selecting voice should not remove
the top tier's ordinary inbound text conversations or website chat. A requested
link or booking confirmation is a separate purpose from the generic missed-call
message, and must follow existing messaging permission and delivery checks.

Recommendation to settle in the detailed plan: offer an explicit text fallback
for voice failures or exhausted voice minutes when SMS is available. Do not
silently send a duplicate generic text after successful voice service. Define
fallback eligibility, user settings, and exact-once handling before enabling it.

## Pricing evidence and commercial decisions

The September 14 discussion verified GPT-Live-1 at $0.05 per minute, billed per
second; backend model/tools are separate. Active session time includes speech,
silence, and waiting. An illustrative Telnyx inbound Voice API plus streaming
path used starting rates totaling $0.0087/minute. These are reference figures,
not an all-in price or an account-specific quote; recheck them when choosing the
transport and final package.

- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [GPT-Live cost accounting](https://developers.openai.com/api/docs/guides/voice-latency-cost)
- [Telnyx Voice API pricing](https://telnyx.com/pricing/voice-api)

Commercial recommendation accepted by the owner: reserve voice for the top
tier, include a measured monthly minute allowance, consider opted-in extra
usage, and use actual quality, task success, and total costs to set the package.
Finalize and implement that commercial packaging before general release.
