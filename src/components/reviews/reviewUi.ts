export const REVIEW_TIMEZONES = [
  ["America/New_York", "Eastern"],
  ["America/Detroit", "Eastern — Detroit"],
  ["America/Indiana/Indianapolis", "Eastern — Indianapolis"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"],
  ["America/Adak", "Aleutian Islands"],
  ["Pacific/Honolulu", "Hawaii"],
] as const;

const REASONS: Record<string, string> = {
  email_missing: "No valid email address",
  phone_missing: "No valid phone number",
  customer_unavailable: "Customer is no longer available",
  duplicate_destination: "Contact destination already selected",
  cooldown: "Recently requested or already scheduled",
  unsubscribe: "Unsubscribed",
  suppressed: "Review requests are blocked for this contact method",
  permission_revoked:
    "Permission was revoked. Record renewed permission before requesting another review.",
  customer_changed: "Contact details changed",
  contact_changed: "Contact details changed",
  email_allowance_reached: "Email allowance reached",
  owner_cancelled: "Stopped by you",
  clicked: "Google link clicked",
  reviewed: "Marked reviewed by you",
  schedule_stale: "Choose a new send time",
  invalid_review_google_url:
    "Use your business’s Google review link, beginning with https://.",
  review_setup_incomplete:
    "Save your Google review link and business postal address first.",
  review_preview_expired:
    "This preview expired. Create a fresh preview before sending.",
  review_email_rate_limit:
    "Please wait before trying again. Test and verification emails are limited to five per day.",
  review_sending_unavailable:
    "Review sending is paused or billing needs attention.",
  review_attestations_required:
    "Confirm the completed work and permission for this channel before continuing.",
  notification_email_must_be_verified:
    "Choose your verified account or Reply-To address for notifications.",
  invalid_review_schedule: "Choose a future send time within the next 90 days.",
  review_sms_quote_changed:
    "Your price quote or subscription changed. Close this window and review the activation price again.",
  review_sms_payment_in_progress:
    "Payment is still being confirmed. Check status before trying again.",
  review_sms_not_ready:
    "Carrier approval or payment is still pending. Check your texting status.",
  review_sms_setup_required:
    "Complete and save your texting approval details first.",
  review_sms_setup_invalid:
    "Check your business details, phone number, and consent evidence before saving.",
  review_sms_number_conflict:
    "That number is no longer available. Choose another number.",
  review_sms_existing_brand_identity_locked:
    "Your registered business identity cannot be changed here. Contact support to update it.",
  review_sms_existing_campaign_needs_approval:
    "Your existing texting registration needs approval for review requests. Contact support.",
  review_sms_risk_review_required:
    "Your business registration needs a support review before submission.",
  review_sms_refund_unavailable:
    "This application can no longer be refunded from this screen. Contact support if you believe there was a mistake.",
  review_sms_recovery_required:
    "Your activation needs a support check before continuing. No new application should be started.",
  review_sms_provider_recovery_required:
    "The registration result needs a support check. Do not start another application.",
  review_sms_managed_billing:
    "Your account provider manages texting access and billing. Contact them to continue.",
  review_sms_price_unavailable:
    "Review texting pricing is not available for activation yet.",
  review_sms_activation_price_unavailable:
    "The registration payment is not available yet. Your saved details are safe.",
};
export function reviewReason(reason: string): string {
  return REASONS[reason] || reason.replaceAll("_", " ");
}
export async function reviewRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof value?.message === "string"
        ? value.message
        : typeof value?.error === "string"
          ? reviewReason(value.error)
          : "We couldn’t complete that review request. Please try again.",
    );
  return value as T;
}
export function reviewTime(value: string, timezone?: string): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return "Time unavailable";
  return at.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

/** The UI displays an explicit device-zone label before converting to UTC. */
export function reviewSchedule(value: string): string {
  const at = new Date(value);
  if (!value || !Number.isFinite(at.getTime()))
    throw new Error("Choose a valid send date and time.");
  return at.toISOString();
}
