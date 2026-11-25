/**
 * Gift codes: Stripe promotion codes that Bryan hands to a customer.
 *
 * This module is pure (no Stripe, no cookies, no "server-only") so the signup
 * form, the email and the tests can all share it.
 */

/** Browser cookie that remembers a code between the email's button and checkout. */
export const GIFT_CODE_COOKIE = "sa_gift_code";
export const GIFT_CODE_COOKIE_MAX_AGE_SECONDS = 60 * 24 * 60 * 60;

/** Key in the Supabase Auth user metadata written at signup. */
export const GIFT_CODE_METADATA_KEY = "gift_code";

// Stripe promotion codes are letters, digits and dashes.
const GIFT_CODE_PATTERN = /^[A-Za-z0-9-]{3,64}$/;

/** Returns the trimmed code, or null when it cannot be a promotion code. */
export function normalizeGiftCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return GIFT_CODE_PATTERN.test(code) ? code : null;
}

/**
 * The codes a signed-in customer is carrying, most recent intent first: the
 * browser cookie from the email's button, then the one saved on their account at
 * signup. Duplicates (ignoring case) are dropped.
 */
export function carriedGiftCodes(
  cookieValue: unknown,
  userMetadata: unknown,
): string[] {
  const fromAccount =
    typeof userMetadata === "object" && userMetadata !== null
      ? (userMetadata as Record<string, unknown>)[GIFT_CODE_METADATA_KEY]
      : null;
  const codes: string[] = [];
  for (const candidate of [cookieValue, fromAccount]) {
    const code = normalizeGiftCode(candidate);
    if (code && !codes.some((seen) => seen.toLowerCase() === code.toLowerCase())) {
      codes.push(code);
    }
  }
  return codes;
}

export type GiftOffer =
  | {
      kind: "percent";
      percentOff: number;
      duration: "once" | "repeating" | "forever";
      months: number | null;
    }
  | {
      kind: "amount";
      /** In the currency's smallest unit (cents). */
      amountOff: number;
      currency: string;
      duration: "once" | "repeating" | "forever";
      months: number | null;
    };

function formatAmount(amountOff: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: amountOff % 100 === 0 ? 0 : 2,
    }).format(amountOff / 100);
  } catch {
    return `${(amountOff / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function period(offer: GiftOffer): string {
  if (offer.duration === "forever") return "every month";
  if (offer.duration === "repeating" && offer.months && offer.months > 1) {
    return `your first ${offer.months} months`;
  }
  return "your first month";
}

/** True for the usual gift: 100% off for a limited time. */
export function isFreeGift(offer: GiftOffer): boolean {
  return offer.kind === "percent" && offer.percentOff >= 100;
}

/**
 * What the code gives, as a short sentence fragment that fits after
 * "This code gives you ": "your first month free", "50% off your first
 * month", "$20 off every month".
 */
export function describeGiftOffer(offer: GiftOffer): string {
  if (isFreeGift(offer)) {
    return offer.duration === "forever"
      ? "100% off every month"
      : `${period(offer)} free`;
  }
  const value =
    offer.kind === "percent"
      ? `${Number(offer.percentOff.toFixed(2))}%`
      : formatAmount(offer.amountOff, offer.currency);
  return `${value} off ${period(offer)}`;
}

/** A headline for the email. */
export function giftHeadline(offer: GiftOffer): string {
  if (isFreeGift(offer) && offer.duration !== "forever") {
    return offer.duration === "repeating" && offer.months && offer.months > 1
      ? `Your first ${offer.months} months are on us`
      : "Your first month is on us";
  }
  const described = describeGiftOffer(offer);
  return `A gift for you: ${described}`;
}

/** "March 3, 2027", in UTC so the server and the browser agree. */
export function formatGiftExpiry(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The link behind the email's button: it remembers the code, then opens
 * signup (see src/app/gift/[code]/start/route.ts).
 */
export function giftStartPath(code: string): string {
  return `/gift/${encodeURIComponent(code)}/start`;
}

/** Reads the gift cookie out of a raw Cookie header. */
export function giftCodeFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const equals = pair.indexOf("=");
    if (equals === -1 || pair.slice(0, equals).trim() !== GIFT_CODE_COOKIE) continue;
    let value = pair.slice(equals + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    return normalizeGiftCode(value);
  }
  return null;
}
