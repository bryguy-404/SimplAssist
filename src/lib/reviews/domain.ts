import { createHmac, timingSafeEqual } from "node:crypto";
import { getCanonicalAppOrigin } from "@/lib/branding/defaultBrand";
import { normalizePhone } from "@/lib/customers/domain";

export function normalizeReviewPhone(
  value: string | null | undefined,
): string | null {
  try {
    return normalizePhone(value ?? "");
  } catch {
    return null;
  }
}
export type ReviewTokenPurpose =
  | "review"
  | "unsubscribe"
  | "preview"
  | "reply_to";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function secret() {
  const value = process.env.REVIEWS_LINK_SECRET ?? "";
  if (Buffer.byteLength(value) < 32)
    throw new Error("reviews_link_secret_unavailable");
  return value;
}
export function signReviewToken(
  id: string,
  purpose: ReviewTokenPurpose,
): string {
  if (!UUID.test(id)) throw new Error("invalid_review_id");
  const signature = createHmac("sha256", secret())
    .update(`reviews:v1:${purpose}:${id}`)
    .digest("base64url");
  return `v1.${id}.${signature}`;
}
export function verifyReviewToken(
  token: string,
  purpose: ReviewTokenPurpose,
): string | null {
  const pieces = token.split(".");
  if (pieces.length !== 3 || pieces[0] !== "v1" || !UUID.test(pieces[1]))
    return null;
  const expected = signReviewToken(pieces[1], purpose);
  const a = Buffer.from(token),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? pieces[1] : null;
}
export function reviewOrigin(): string {
  const url = new URL(getCanonicalAppOrigin());
  if (
    (url.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("invalid_reviews_origin");
  return url.origin;
}
export function normalizeReviewEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
    ? email
    : null;
}
export function validateGoogleReviewUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      return null;
    const allowed =
      url.hostname === "g.page" ||
      url.hostname === "search.google.com" ||
      url.hostname === "maps.app.goo.gl" ||
      url.hostname === "www.google.com" ||
      url.hostname === "google.com";
    if (
      !allowed ||
      /\/url(?:\/|$)/.test(url.pathname) ||
      url.searchParams.has("url") ||
      (url.searchParams.has("q") &&
        /^https?:/i.test(url.searchParams.get("q") ?? ""))
    )
      return null;
    if (
      ["www.google.com", "google.com"].includes(url.hostname) &&
      !url.pathname.startsWith("/maps")
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
export function validateReviewTimezone(value: unknown): string {
  const timezone = typeof value === "string" ? value : "America/New_York";
  if (
    !/^(America\/(New_York|Detroit|Indiana\/Indianapolis|Chicago|Denver|Phoenix|Los_Angeles|Anchorage|Adak)|Pacific\/Honolulu)$/.test(
      timezone,
    )
  )
    throw new Error("unsupported_review_timezone");
  return timezone;
}
/** Search UTC instants, so DST gaps/folds cannot manufacture a local send time. */
export function nextReviewSendTime(input: Date, timezone: string): Date {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hourCycle: "h23",
  });
  let at = new Date(input);
  for (let n = 0; n < 1500; n++) {
    const hour = Number(format.format(at));
    if (hour >= 9 && hour < 18) return at;
    at = new Date(Math.ceil((at.getTime() + 1) / 60000) * 60000);
  }
  throw new Error("invalid_review_schedule");
}
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function renderReviewTemplate(
  template: string,
  business: string,
  customer: string,
): string {
  if (/\{\{(?!business_name\}\}|customer_name\}\})/.test(template))
    throw new Error("unsupported_template_variable");
  return template.replace(
    /\{\{(business_name|customer_name)\}\}/g,
    (_placeholder, field: string) =>
      field === "business_name" ? business : customer || "there",
  );
}
export function buildReviewEmail(args: {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  body: string;
  business: string;
  customer: string;
  enrollmentId: string;
  businessId: string;
}) {
  const review = `${reviewOrigin()}/r/${signReviewToken(args.enrollmentId, "review")}`;
  const unsubscribe = `${reviewOrigin()}/reviews/unsubscribe/${signReviewToken(args.enrollmentId, "unsubscribe")}`;
  const subject = renderReviewTemplate(
    args.subject,
    args.business,
    args.customer,
  );
  const body = renderReviewTemplate(args.body, args.business, args.customer);
  return {
    from: args.from,
    to: [args.to],
    replyTo: args.replyTo,
    subject,
    text: `${body}\n\nLeave an honest Google review: ${review}\n\n${args.business}\nUnsubscribe from review requests: ${unsubscribe}`,
    html: `<p>${escapeHtml(body).replaceAll("\n", "<br>")}</p><p><a href="${review}">Leave an honest Google review</a></p><p>${escapeHtml(args.business)}</p><p><a href="${unsubscribe}">Unsubscribe from review requests</a></p>`,
    headers: {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [
      { name: "review_business", value: args.businessId },
      { name: "review_enrollment", value: args.enrollmentId },
    ],
  };
}
export function verifyResendWebhook(
  raw: string,
  headers: Headers,
  now = Date.now(),
): boolean {
  const secretValue = process.env.REVIEWS_RESEND_WEBHOOK_SECRET ?? "";
  const id = headers.get("svix-id"),
    timestamp = headers.get("svix-timestamp"),
    signature = headers.get("svix-signature");
  if (
    !secretValue.startsWith("whsec_") ||
    !id ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !signature ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return false;
  const key = Buffer.from(secretValue.slice(6), "base64");
  if (key.length < 24) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${raw}`)
    .digest();
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const actual = Buffer.from(sig, "base64");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  });
}
