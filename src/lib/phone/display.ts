import { isE164PhoneNumber } from "./e164";

/**
 * Display-only formatting for owner-facing screens. US/Canada numbers read as
 * "(317) 555-1234"; anything else is returned unchanged so an unusual stored
 * value is never hidden or mangled. Stored values stay E.164.
 */
export function formatPhoneForDisplay(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";

  const digits = raw.replace(/\D/g, "");
  const national =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits.length === 10 && !raw.startsWith("+")
        ? digits
        : null;
  if (!national) return raw;

  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

/**
 * Accepts the ways people actually type a phone number — "(317) 555-1234",
 * "317-555-1234", "3175551234", "1 317 555 1234", or full "+13175551234" —
 * and returns E.164, or null when it cannot be read as a phone number.
 */
export function parsePhoneInputToE164(
  value: string | null | undefined
): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (!/^\+?[\d\s().-]+$/.test(raw)) return null;

  const digits = raw.replace(/\D/g, "");
  const candidate = raw.startsWith("+")
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? `+${digits}`
        : null;

  return candidate && isE164PhoneNumber(candidate) ? candidate : null;
}

/**
 * True when a search box query matches a stored phone number. Numbers are
 * shown as "(317) 555-1234" but stored as "+13175551234", so a phone-like
 * query is compared digits to digits.
 */
export function phoneMatchesSearch(
  phone: string | null | undefined,
  query: string
): boolean {
  const stored = phone ?? "";
  const q = query.trim();
  if (!stored || !q) return false;
  if (stored.includes(q)) return true;
  if (/[a-z]/i.test(q)) return false;

  const queryDigits = q.replace(/\D/g, "");
  return queryDigits.length >= 2 && stored.replace(/\D/g, "").includes(queryDigits);
}

/**
 * Prepares a search box query for a plain substring match against stored
 * E.164 numbers: a phone-shaped query such as "(317) 555-12" becomes
 * "31755512". Anything that is not phone-shaped is returned unchanged.
 */
export function normalizePhoneSearch(query: string): string {
  const q = query.trim();
  if (!/^\+?[\d\s().-]+$/.test(q) || /^\d+$/.test(q)) return query;

  const digits = q.replace(/\D/g, "");
  return digits.length >= 3 ? digits : query;
}
