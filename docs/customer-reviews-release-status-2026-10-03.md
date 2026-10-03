# Customers and Reviews release status — October 3, 2026

The Customers workspace and Reviews application code are deployed in production.
Access is limited to the owner's pilot business. Deployment is not a general
release to every account or activation of the new pricing and review texting.

## Deployed and verified

- Implementation revision: `73d51c2`.
- Current application revision: `240640d`, including the mailing-address and
  footer changes. This documentation update does not change application code.
- Database migrations 095–102 are applied. Tenant access controls and migration
  contents were independently verified against the canonical source.
- The web application, dedicated review worker and signed Resend delivery
  webhook are active. Existing voice and booking workers were preserved.
- The live owner can use Customers and Reviews. Settings save without a postal
  address; newly generated review emails omit it.
- The footer revision passed 90 focused tests across 13 files, TypeScript and
  lint. The signed-in live settings save and deployment health check passed.
- Two separate owner-preview emails were delivered exactly once each, with
  signed provider delivery events recorded.

## Pending pilot verification

One normal customer-style email is scheduled solely to the owner's test contact
for October 3, 2026 at 9 AM Eastern. The preview and frozen payload contain the
signed Google-review and unsubscribe links, with no reminder. The original
customer records are unchanged; one clearly labeled self-test contact was added.

This message must be delivered before testing its links. Following the Google
link early would stop the pending request. After delivery, verify the redirect
and clicked status, then unsubscribe and confirm suppression blocks further
review requests. Restore the original account pause and disabled dispatch
control after the test. A single follow-up is scheduled for 9:05 AM Eastern.

Delivery, click and unsubscribe results for this full-flow test are still
pending. The earlier owner-preview messages used placeholder links and do not
substitute for this verification. Private operational evidence remains outside
the committed release report.

## Remaining release work

- Enable customer/email-review access for other intended accounts after the
  pilot passes. Account migrations can be handled individually.
- Complete review-SMS carrier approval and live sender/permission checks before
  enabling review texting.
- Finish the Stripe activation/add-on lifecycle checks and validate operating
  costs before activating the new prices and public pricing flag.
- Completion automation and reminders remain off until explicitly configured.

See [the release guide](./customer-reviews-release.md) and
[operations](./review-request-operations.md) for rollout controls and recovery.
