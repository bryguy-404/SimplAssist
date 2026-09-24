# Owner booking SMS alerts — Telnyx handoff

## Resume here

**September 23, 2026, after production deployment: the revised campaign was saved successfully.** The historical unsaved draft below is superseded by this update. Production release `c955d4c` is deployed; owner SMS enrollment and sending remain disabled. In the normal Telnyx editor for CYLIGTZ, the description, message flow, keywords, responses, three samples, policy URLs, sample embedded link, and Embedded Link=Yes were saved and then verified by reopening the editor. The full description and workflow persisted. The Save button was disabled on reopening, with no unsaved changes.

The campaign still displays **Active**, and +15742133931 remains **Assigned**. The More menu offers only Edit campaign and Deactivate campaign; no new-review/resubmit action or new approval confirmation was shown. Do not infer approval of the revised program or a $15 charge from this Save. Confirm the provider's review requirements before setting `OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED=true`.

**Follow-up read-only API verification, September 23:** `GET /v2/10dlc/campaign/4b30019d-f3cb-4e4f-b473-9a05bffeccb2` returned `status=ACTIVE`, `campaignStatus=MNO_PROVISIONED`, `submissionStatus=CREATED`, `isTMobileRegistered=true`, `isTMobileSuspended=false`, `failureReasons=null`, and the complete saved revised description/message flow with `embeddedLink=true`. `GET /v2/10dlc/phone_number_campaigns/+15742133931` returned CYLIGTZ and `assignmentStatus=ASSIGNED`, no failure. This is stronger evidence than the portal badge: no pending review/rejection is reported and the campaign remains carrier-provisioned. It still does not establish that the substantive consent-method revision was freshly reviewed or exempt from re-review. Official Telnyx event documentation distinguishes CAMPAIGN_UPDATE from CAMPAIGN_RESUBMISSION/review events; no published definitive rule about this approved-campaign edit scenario was found. Do not claim re-review definitely is or is not required.

The dedicated number's actual profile is **SimplAssist Production**, ID `40019df3-9a51-4822-ac75-48b62f40a630`, enabled, no number pool. It still points to the OLD inbound webhook `https://www.simplassist.com/api/messaging/webhook`, not the owner-alert endpoint. Runtime autoresponses are still the original defaults: START promises resubscription, STOP generic unsubscribe, HELP generic SimplAssist support. They were read only and must be configured for the owner-alert semantics before a pilot. Campaign declarations did not change these runtime settings. No activation, test SMS, or support message occurred during this research.

Primary reference: https://developers.telnyx.com/docs/messaging/10dlc/event-notifications/index (MNO_PROVISIONED means provisioned with all MNOs; update and review events are separate).

Saved registration reflects the deployed form at `https://simplassist.com/settings#booking-alerts`, public explanation at `https://simplassist.com/booking-alerts`, optional unchecked consent, exact disclosure, inbound `ALERTS <one-time token>` from the entered US mobile, 15-minute expiry, business-specific verification, STOP across all businesses for the recipient, START/UNSTOP unblock without reenrollment, and HELP/INFO support. It explicitly says enrollment and sending are disabled pending approval of the revised campaign.

- Opt-in keyword declaration: `ALERTS`; response matches the application's successful enrollment confirmation. Bare ALERTS does not enroll.
- Opt-out declarations: `STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT`. Telnyx rejected the first Save because `STOP ALL` contained a space; removing that metadata entry allowed Save. The application can still recognize STOP ALL.
- Help declarations: `HELP,INFO`; support `bryan@simplassist.com`.
- Samples: two new appointment notices for Solar Example (Oct 15, 2026, 10:00 AM EDT and Oct 16, 2026, 2:30 PM EDT), business/time/secure dashboard navigation URL, STOP/HELP; third sample is the exact enrollment confirmation.
- Example navigation tokens are 43 `A` or `B` characters under `/booking-alerts/open/`, clearly illustrative and not active tokens.
- Privacy: `https://simplassist.com/privacy#owner-booking-alerts`; terms: `https://simplassist.com/terms#owner-booking-alerts`.
- Embedded Link=Yes; Embedded Phone Number/Number Pooling/Age-Gated/Direct Lending=No.
- Campaign provisioning webhooks remain blank. These are not inbound SMS webhooks.

No other campaign, phone assignment, messaging profile runtime settings, application activation flags, or recipient enrollment was changed. **Do not configure ALERTS as a messaging-profile START autoresponder**: it must reach application token verification. Dedicated profile webhook and keyword runtime configuration, worker deployment, reconciliation, approved pilot, and staged activation remain separate next steps in `owner-booking-alerts-operations.md`. Authenticated form reviewer screenshots may be requested; the public page describes the actual deployed flow but the form remains disabled pending review.

## Historical pre-implementation handoff (archived)

Bryan wants to implement owner booking alerts after planning the full feature in Codex, then return to Telnyx. On September 23, 2026, he chose to cancel the unsaved Telnyx edits until the feature's consent setup is ready. **The assistant did not click Save, submit for review, create a campaign, reassign a number, send a text, or change application code.** Browser cancellation is being handled by Bryan.

This note preserves the actual unsaved field values entered and verified in the browser. Bryan does not need to read or re-enter this material himself. Use it as a handoff for the implementation and later provider work.

**Do not blindly resubmit the archived wording below.** It deliberately says the feature is planned and not live. After implementation, replace those statements with the verified, actual consent process, final URLs, and reviewer evidence. A successful Save is not proof of carrier approval.

## Product decisions to carry into planning

- Notify business account holders after SimplAssist successfully creates a real, confirmed calendar appointment. Do not describe an unconfirmed request as a booking.
- Initial release is SMS only; email or both can be added later.
- Include eligible Chat Only accounts. Receiving a platform notification is separate from customer-facing SMS entitlements and business sender registration.
- Use one approved SimplAssist platform sender for these owner notifications. Recipients do not need their own Telnyx number to receive alerts.
- Optional, dismissible dashboard setup card and an editable Settings section. The final section name/path needs to match the implementation.
- Store the owner alert destination separately from onboarding and call-forwarding settings. A user's own SMS-capable mobile can serve both call forwarding and alert receipt. Avoid treating a customer-facing AI number as the owner's mobile destination.
- Collect explicit SMS consent and verify control of the recipient number. Finalize the verification mechanism and ensure its messages are covered by the appropriate provider registration; that mechanism has not been selected yet.
- Design booking event handling, duplicate prevention, opt-out/HELP handling, delivery failure handling, and tenant/account isolation. Do not reuse customer/caller booking texts as owner alerts without a separate destination and purpose.
- No implementation work was authorized in this documentation turn. The next planned activity is planning the complete feature, with consent setup and matching disclosures before the Telnyx submission.

## Existing provider resources

| Resource | Value |
| --- | --- |
| Brand | SimplAssist, verified |
| TCR brand ID | BL69PDP |
| Internal brand ID | 4b20019d-e93e-d697-b8ee-c6233e9bf533 |
| Existing campaign to try first | CYLIGTZ |
| Internal campaign ID | 4b30019d-f3cb-4e4f-b473-9a05bffeccb2 |
| Use case | Account Notification |
| Last observed campaign status | Active |
| Candidate sender | +15742133931 / (574) 213-3931 |
| Number assignment | Assigned to CYLIGTZ |
| Messaging profile | SimplAssist Production |
| Number capabilities observed | Domestic SMS and MMS; international unsupported in the shown settings |

Details: https://portal.telnyx.com/#/messaging-10dlc/campaigns/details/4b30019d-f3cb-4e4f-b473-9a05bffeccb2

Editor: https://portal.telnyx.com/#/messaging-10dlc/campaigns/edit/4b30019d-f3cb-4e4f-b473-9a05bffeccb2

Number: https://portal.telnyx.com/#/messaging/my-numbers/2952480777431942401?tab=messaging

**Keep the homepage demo number +15742638634 / (574) 263-8634 untouched.** It uses the Arambula Ventures profile/connection and is actively used for demos. The SimplAssist brand also has active campaign CF3YOXJ (`4b30019f-8814-cb6c-1e77-950fa70e0410`); this investigation targeted CYLIGTZ only.

## What was verified in the editor

The approved-campaign banner says only keywords, auto-responses, sample messages, and webhooks can be edited. Native browser tests nevertheless confirmed that the description, opt-in workflow, and Embedded Link radio option accept changes, and Save becomes enabled. This establishes UI editability only. Backend persistence and review requirements remain untested.

The portal displays a $15 fee for each carrier-review submission/resubmission. Do not assume every Save necessarily initiates review or charges that fee. Bryan said he is willing to pay $15 **if everything is ready**; that was not authorization to pay for an incomplete planned flow. Recheck actual readiness, the displayed charge, and the session's authorization before submitting.

The original approved registration describes subscription/billing/password/account notifications with verbal consent during calls to +15743236945. It does not describe the proposed dashboard owner-alert enrollment. Original sample messages were a subscription renewal and a password reset. Original Embedded Link was No, and the separate privacy/terms/sample-link fields were blank.

## Exact unsaved campaign description entered

```text
Planned SimplAssist platform booking-alert program for business account holders who expressly opt in. Transactional SMS will notify the account holder when SimplAssist successfully creates a confirmed appointment in their connected calendar. Messages will identify SimplAssist and may link to the authenticated dashboard. Recipients will be SimplAssist account holders, including eligible Chat Only users; this campaign will not send marketing or messages to their customers. The dashboard opt-in flow is not yet implemented. No booking-alert traffic will be sent until the consent process is operational and any required approval is complete.
```

## Exact unsaved opt-in workflow entered

```text
PROPOSED WORKFLOW - NOT YET LIVE. The dashboard booking-alert opt-in form has not been implemented. This update describes the intended program for review before implementation. No booking alerts will be sent until the consent process is operational and any required approval is complete.

Account holders will sign in at https://simplassist.com and open Settings > Notifications at https://simplassist.com/settings. An optional dashboard card will also direct them to this setup. They will enter their alert mobile number, select an unchecked SMS-consent checkbox and choose Enable booking texts. Enrolling will be optional, separate from account registration, call forwarding, customer messaging and email preferences.

The checkbox will say: "I agree to receive automated text messages from SimplAssist when an appointment is booked in my connected calendar. Message frequency varies with bookings. Message and data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase."

The form will link to https://simplassist.com/privacy and https://simplassist.com/terms and display support contact bryan@simplassist.com. These existing public policies will be updated to describe the owner booking-alert program before launch. The service will record the recipient number, account, consent timestamp and disclosure version and send an enrollment confirmation. Alerts will be sent only after successful creation of a confirmed calendar appointment and only to opted-in recipients. STOP will disable further alerts; HELP will provide support information. These mechanisms will be implemented before traffic begins.
```

The description was 643 characters; the workflow was 1,647 characters. No visible validation errors were present at the final check. These counts do not establish provider acceptance.

## Exact unsaved samples entered

Message 1:

```text
SimplAssist: New appointment booked for your business on Oct 15 at 10:00 AM ET. View details: https://simplassist.com/dashboard Reply STOP to opt out; HELP for help.
```

Message 2:

```text
SimplAssist: An appointment is confirmed in your connected calendar for Oct 16 at 2:30 PM ET. View details: https://simplassist.com/dashboard Reply STOP to opt out.
```

Dates and times are illustrative. The implementation must use the actual appointment time and business timezone, and may need a business label for owners with multiple accounts. Final examples should reflect the actual message template.

## Exact unsaved automatic responses entered

Opt-in:

```text
SimplAssist: Booking texts enabled. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help. Support: bryan@simplassist.com.
```

Opt-out:

```text
SimplAssist: You are unsubscribed from booking texts and will receive no further alerts. For help, email bryan@simplassist.com.
```

Help:

```text
SimplAssist booking alerts: Email bryan@simplassist.com for help. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out.
```

## Remaining exact fields

| Field | Prepared value | Change |
| --- | --- | --- |
| Opt-in keywords | START,YES | Unchanged |
| Opt-out keywords | STOP,UNSUBSCRIBE,END,QUIT,CANCEL | Unchanged |
| Help keywords | HELP | Unchanged |
| Privacy policy | https://simplassist.com/privacy | Filled |
| Terms and conditions | https://simplassist.com/terms | Filled |
| Embedded link sample | https://simplassist.com/dashboard | Filled |
| Embedded Link | Yes | Changed from No |
| Embedded Phone Number | No | Unchanged |
| Number Pooling | No | Unchanged |
| Age-Gated Content | No | Unchanged |
| Direct Lending or Loan Arrangement | No | Unchanged |
| Campaign provisioning webhooks | Blank | Unchanged |
| Number assignment | +15742133931 | Unchanged |

## Return to Telnyx after implementation

1. Verify the actual owner enrollment screen, optional SMS consent, verification method, consent records, and matching public SMS/privacy disclosures. Provide the real form URL and appropriate reviewer evidence/access if it is behind login. A settings URL without the form does not demonstrate consent.
2. Reconcile this archived draft with the real implementation. Replace planned/not-live language only when true. Include any verification messages accurately, and confirm the opt-in/STOP/HELP responses match the actual sender behavior.
3. Try the existing campaign first. Use the editor normally; do not bypass field restrictions. Confirm required fields really persist after Save and inspect the resulting review/status requirements.
4. A pre-existing Active badge or successful Save alone does not establish approval for the changed workflow. Complete any required provider/carrier review and verify the number remains correctly assigned before enabling booking-alert traffic.
5. If Telnyx cannot accept the necessary changes to this campaign, use a new campaign under the existing verified SimplAssist brand. After approval, reassign the unused +15742133931 number and wait for assignment completion. Do not release the number or alter the demo sender.

## Relevant code observations from this investigation

- `src/app/(dashboard)/settings/page.tsx`: no owner booking-alert consent section was present when inspected.
- `src/lib/billing/features.ts`: earlier inspection showed calendar/direct booking enabled for Chat Only; verify current entitlements during planning.
- `src/lib/booking/notifications.server.ts`: existing booking notifications target callers/customers. Owner destinations need a separate flow.
- `src/app/(public)/privacy/page.tsx` and `src/app/(public)/terms/page.tsx`: current public SMS wording described customer messaging; owner platform alerts need accurate coverage.
- Existing Telnyx and Resend infrastructure can be investigated during implementation. Email remains outside the first release.

## Provider references to recheck when submitting

- https://support.telnyx.com/en/articles/9940291-10dlc-campaign-compliance-requirements
- https://support.telnyx.com/en/articles/7127078-10dlc-campaign-approval-best-practices
- https://developers.telnyx.com/api-reference/campaign/update-campaign
- https://support.telnyx.com/en/articles/6339152-how-to-create-a-10dlc-campaign
- https://support.telnyx.com/en/articles/11072276-10dlc-number-assignment-status

Telnyx's compliance guidance says the stated mechanisms should exist at submission. Its update API documentation is internally inconsistent about editable fields (the summary says only samples; the request includes messageFlow but not description or embeddedLink). Do not turn that uncertainty into a promise that the existing campaign will accept all changes, or treat support contact as mandatory if the self-service route works.
