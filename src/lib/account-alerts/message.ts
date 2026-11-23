import { z } from "zod";

export const ACCOUNT_ALERT_RECIPIENT = "bryan@simplassist.com";
const timestamp = z.string().datetime({ offset: true });
export const accountAlertPayloadSchema = z.object({
  version: z.literal(1),
  businessId: z.string().uuid(),
  name: z.string().max(200),
  email: z.email().max(254),
  businessName: z.string().nullable(),
  plan: z.enum(["chat_only", "sms_only", "sms_and_chat", "full"]).nullable(),
  signedUpAt: timestamp,
  occurredAt: timestamp,
  kind: z.enum(["verified_signup", "chat_ready", "texting_submitted"]),
  brandStatus: z.string().nullable(),
  campaignStatus: z.string().nullable(),
}).strict();

export const accountAlertMessageSchema = z.object({
  from: z.string().min(1).max(320).refine((s) => !/[\r\n]/.test(s)),
  to: z.literal(ACCOUNT_ALERT_RECIPIENT),
  replyTo: z.email().max(254),
  subject: z.string().min(1).max(500).refine((s) => !/[\r\n]/.test(s)),
  text: z.string().min(1).max(10000),
  html: z.string().min(1).max(20000),
}).strict();
export type AccountAlertMessage = z.infer<typeof accountAlertMessageSchema>;

const plans = {
  chat_only: "Chat Only", sms_only: "Starter / SMS Only",
  sms_and_chat: "Growth / SMS + Web Chat", full: "Pro / Full Suite",
};
function clean(value: string | null, fallback: string) {
  return value?.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 200) || fallback;
}
function escape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function time(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Indiana/Indianapolis", dateStyle: "medium", timeStyle: "short",
  }).format(new Date(value)) + " (Indianapolis time)";
}

export function renderAccountAlert(payload: unknown, from: string, appOrigin: string): AccountAlertMessage {
  const p = accountAlertPayloadSchema.parse(payload);
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) {
    throw new Error("invalid_account_alert_origin");
  }
  const adminUrl = new URL(`/admin/${p.businessId}`, origin.origin).toString();
  const person = clean(p.name, p.email);
  const business = clean(p.businessName, "Business details not entered yet");
  const title = p.kind === "verified_signup" ? "New verified signup"
    : p.kind === "chat_ready" ? "Chat Only account ready" : "Texting setup submitted";
  const status = p.kind === "verified_signup" ? "Email verified. Setup may still be in progress; this is not a payment confirmation."
    : p.kind === "chat_ready" ? "Paid Chat Only setup is complete. The customer can access their dashboard; no carrier approval is needed."
    : p.campaignStatus === "approved" ? "Paid texting setup has been submitted, and carrier approval has already been recorded. Check the account for current number readiness."
    : "Paid texting setup has been submitted for carrier review. The customer may be waiting for approval—this is a good time to check in.";
  const lines = [title, "", `Name: ${person}`, `Email: ${p.email}`, `Business: ${business}`,
    `Plan: ${p.plan ? plans[p.plan] : "Plan not selected yet"}`, `Signed up: ${time(p.signedUpAt)}`,
    `Milestone reached: ${time(p.occurredAt)}`, "", status,
    "", `View account: ${adminUrl}`, "Reply to this email to contact the customer.",
    "Details reflect the milestone when recorded; the admin page shows the latest status."];
  return accountAlertMessageSchema.parse({
    from, to: ACCOUNT_ALERT_RECIPIENT, replyTo: p.email,
    subject: `SimplAssist — ${title} — ${p.kind === "verified_signup" ? person : business}`,
    text: lines.join("\n"),
    html: lines.map((line) => `<p>${escape(line)}</p>`).join("") + `<p><a href="${escape(adminUrl)}">View account</a></p>`,
  });
}
