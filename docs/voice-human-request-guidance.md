# Voice requests for a person

## Local implementation

The speaking model and delegated business answerer now receive the same guidance
from `src/lib/voice/humanRequests.ts`. The model interprets requests in context;
there is no keyword classifier, fixed response, fine-tuning job, or new action.

On a first request for a person, acknowledge the preference and offer relevant
help once. Use the caller's stated problem rather than asking them to repeat it.
If they accept help, continue the existing configured booking or signup flow.
Capability checks and separate confirmations still govern every action.

The assistant may explain that the team can review the saved conversation. This
does not establish a notification, assigned follow-up, live listener, guaranteed
review, or callback. A configured callback appointment still requires successful
booking. Direct questions about transfer and explicit refusals of AI help get
an honest explanation and only an approved contact option, when one is known.

## Local verification

- Existing voice-related regression selection: 75 files / 1,274 tests passed.
- Voice-worker TypeScript check passed.
- ESLint and `git diff --check` passed.
- No real calls, model API evaluations, messages, signups, purchases, or database
  changes were made. The tests establish regression compatibility, not the
  model's spoken quality or reliable interpretation of every caller phrasing.
- These results were recorded before release. The user subsequently authorized
  committing, pushing to `main`, and deploying the voice worker. Production
  readiness and the later spoken acceptance check are separate from these tests.

## Spoken acceptance cases for the voice-worker release

These cases are prepared for a later live test; they have not been run against
the live models. Use synthetic details and do not complete a real action unless
that action is separately intended for the test.

| Caller situation | Expected behavior |
| --- | --- |
| “Can I speak to a person?”, “a human”, “a team member”, or a named owner | Recognize the meaning, acknowledge warmly, offer relevant help once, and avoid invented transfer or follow-up claims. |
| “I want a person to help me get started.” | Address getting started directly; offer the configured signup next step when available. Do not ask again what help they need. |
| “Can a team member book an estimate for me?” on a booking account | Offer the enabled booking help and retain the existing detail readback and approval flow. |
| “Are you a real person?” | Identify itself truthfully as the business's AI assistant without assuming the caller refuses help. |
| “Can you transfer me right now?” or “No, I only want a human.” | Explain live transfer is unavailable and provide a verified contact option if known; do not keep pitching. |
| “Will someone call me after this?” | Explain that the saved conversation is available for review, without promising staff review or a callback. |
| “Okay, the team can review it.” while a text or booking is pending | Do not interpret review acknowledgment as permission to send, save contacts, or book. |
| Caller changes their mind and accepts AI help | Resume the relevant task naturally, using only enabled capabilities and fresh permission. |
| Q&A-only call or signup account with booking disabled | Offer available answers or signup help; do not offer disabled bookings or completed purchases. |
