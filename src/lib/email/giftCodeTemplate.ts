import {
  describeGiftOffer,
  formatGiftExpiry,
  giftHeadline,
  isFreeGift,
  type GiftOffer,
} from "@/lib/gift/code";

/**
 * The coupon email Bryan sends from /admin/gift-codes.
 *
 * Mail programs strip scripts, so there is no Copy button here: the code sits
 * in a large box that selects in one tap or double-click, and a button opens
 * the coupon page, which does have a real Copy button.
 *
 * Built to survive real inboxes: table layout, inline styles, no images. The
 * dot mascot is drawn from plain coloured table cells and the brand name is
 * text, so both still show when images are blocked or dark mode is on.
 *
 * Pure: no network, no "server-only", so the admin preview, the demo page and
 * the tests all render exactly what gets sent.
 */

export type GiftCodeEmailInput = {
  firstName?: string | null;
  code: string;
  offer: GiftOffer;
  expiresAt: string | null;
  /** Absolute link to the coupon page for this code. */
  giftUrl: string;
};

export type RenderedGiftCodeEmail = {
  subject: string;
  html: string;
  text: string;
};

const ORANGE = "#ea580c";
const INK = "#1c1917";
const BODY = "#57534e";
const FAINT = "#78716c";
const DOT_INK = "#3a1505";
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A first name worth greeting: trimmed, one line, no markup characters. */
export function cleanFirstName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= 60 ? name : null;
}

function assertGiftUrl(giftUrl: string): string {
  const url = new URL(giftUrl);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/gift/")
  ) {
    throw new Error("Gift email link is malformed");
  }
  return url.toString();
}

/** The still dot: an orange circle with two eyes, from table cells only. */
function dotHtml(): string {
  const eye =
    `<td width="10" height="15" bgcolor="${DOT_INK}" style="width:10px;height:15px;` +
    `border-radius:50%;background-color:${DOT_INK};font-size:0;line-height:0;">&nbsp;</td>`;
  return [
    `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">`,
    `<tr><td width="76" height="76" align="center" valign="top" bgcolor="${ORANGE}" `,
    `style="width:76px;height:76px;border-radius:38px;background-color:${ORANGE};font-size:0;line-height:0;">`,
    `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">`,
    `<tr><td colspan="3" height="25" style="height:25px;font-size:0;line-height:0;">&nbsp;</td></tr>`,
    `<tr>${eye}<td width="15" style="width:15px;font-size:0;line-height:0;">&nbsp;</td>${eye}</tr>`,
    `</table>`,
    `</td></tr></table>`,
  ].join("");
}

export function renderGiftCodeEmail(input: GiftCodeEmailInput): RenderedGiftCodeEmail {
  const giftUrl = assertGiftUrl(input.giftUrl);
  const firstName = cleanFirstName(input.firstName);
  const described = describeGiftOffer(input.offer);
  const baseHeadline = giftHeadline(input.offer);
  const headline = firstName
    ? `${firstName}, ${baseHeadline.charAt(0).toLowerCase()}${baseHeadline.slice(1)}`
    : baseHeadline;
  const expiry = formatGiftExpiry(input.expiresAt);
  const free = isFreeGift(input.offer) && input.offer.duration !== "forever";

  const subject = free
    ? firstName
      ? `${firstName}, here’s your free month of SimplAssist`
      : "Here’s your free month of SimplAssist"
    : "A gift for you from SimplAssist";

  const intro =
    `Here’s a code for ${described} when you sign up for SimplAssist. ` +
    "It’s yours to use whenever you’re ready.";
  const buttonNote =
    "The button opens a page where you can copy the code in one tap and " +
    "start signing up with it already applied.";
  const typeIt =
    "Prefer to type it? At checkout, choose “Add promotion code” and paste the code there.";
  const expiryLine = expiry ? `Good until ${expiry}.` : null;

  const text = [
    headline,
    intro,
    `Your code: ${input.code}`,
    ...(expiryLine ? [expiryLine] : []),
    `Open your gift: ${giftUrl}`,
    buttonNote,
    typeIt,
    "Questions? Just reply to this email.",
    "— The SimplAssist team",
  ].join("\n\n");

  const code = escapeHtml(input.code);
  const href = escapeHtml(giftUrl);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .sa-page { background-color: #0c0a09 !important; }
    .sa-card { background-color: #1c1917 !important; border-color: #3f3a36 !important; }
    .sa-ink { color: #f5f5f4 !important; }
    .sa-body { color: #d6d3d1 !important; }
    .sa-faint { color: #a8a29e !important; }
    .sa-code-box { background-color: #292524 !important; border-color: #78350f !important; }
  }
  @media (max-width: 480px) {
    .sa-card { padding: 28px 20px !important; }
    .sa-code { font-size: 26px !important; }
  }
</style>
</head>
<body class="sa-page" style="margin:0;padding:0;background-color:#faf8f4;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your code is inside: ${code}</div>
<table role="presentation" class="sa-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf8f4;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
<tr><td align="center" class="sa-ink" style="padding:0 0 20px;font-family:${FONT};font-size:20px;font-weight:800;letter-spacing:-0.2px;color:${INK};">SimplAssist</td></tr>
<tr><td class="sa-card" align="center" style="background-color:#ffffff;border:1px solid #ece4d8;border-radius:24px;padding:36px 32px;">
${dotHtml()}
<p class="sa-ink" style="margin:22px 0 0;font-family:${FONT};font-size:26px;line-height:1.25;font-weight:800;letter-spacing:-0.3px;color:${INK};">${escapeHtml(headline)}</p>
<p class="sa-body" style="margin:12px 0 0;font-family:${FONT};font-size:16px;line-height:1.55;color:${BODY};">${escapeHtml(intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
<tr><td class="sa-code-box" align="center" style="background-color:#fdf1e7;border:2px dashed #f0c9a4;border-radius:18px;padding:18px 12px 20px;">
<p class="sa-faint" style="margin:0;font-family:${FONT};font-size:12px;line-height:1.4;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${FAINT};">Your code</p>
<p class="sa-ink sa-code" style="margin:8px 0 0;font-family:${MONO};font-size:30px;line-height:1.2;font-weight:700;letter-spacing:2px;color:${INK};word-break:break-all;-webkit-user-select:all;user-select:all;">${code}</p>
</td></tr>
</table>
${expiryLine ? `<p class="sa-faint" style="margin:10px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${FAINT};">${escapeHtml(expiryLine)}</p>` : ""}
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:26px auto 0;">
<tr><td align="center" bgcolor="${ORANGE}" style="background-color:${ORANGE};border-radius:999px;">
<a href="${href}" target="_blank" style="display:inline-block;padding:15px 34px;font-family:${FONT};font-size:16px;line-height:1.2;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">Open my gift</a>
</td></tr>
</table>
<p class="sa-body" style="margin:18px 0 0;font-family:${FONT};font-size:14px;line-height:1.55;color:${BODY};">${escapeHtml(buttonNote)}</p>
<p class="sa-body" style="margin:14px 0 0;font-family:${FONT};font-size:14px;line-height:1.55;color:${BODY};">${escapeHtml(typeIt)}</p>
</td></tr>
<tr><td align="center" class="sa-faint" style="padding:20px 8px 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${FAINT};">Questions? Just reply to this email.<br>— The SimplAssist team</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}
