import "server-only";

import { normalizeHostHeader } from "@/lib/branding/hostname";

const MAX_ORIGIN_LENGTH = 2048;
const MAX_ALLOWED_HOSTNAMES = 10;

export type NormalizedWidgetOrigin = {
  origin: string;
  hostname: string;
};

/**
 * Parses a browser Origin header into a canonical HTTP(S) origin. Origin is
 * intentionally stricter than a general URL: paths, credentials, lists,
 * opaque origins, and non-HTTP schemes are never accepted.
 */
export function normalizeWidgetOrigin(
  rawOrigin: string | null | undefined,
): NormalizedWidgetOrigin | null {
  if (
    !rawOrigin ||
    rawOrigin.length > MAX_ORIGIN_LENGTH ||
    rawOrigin !== rawOrigin.trim() ||
    /[\s\u0000-\u001f\u007f,]/.test(rawOrigin)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    return null;
  }

  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin === "null" ||
    rawOrigin.endsWith("/")
  ) {
    return null;
  }

  const hostname = normalizeHostHeader(parsed.hostname);
  if (!hostname || hostname !== parsed.hostname.toLowerCase()) return null;

  return { origin: parsed.origin, hostname };
}
/**
 * Treats malformed persisted configuration as unavailable rather than
 * silently widening or repairing an allowlist at request time.
 */
export function parseConfiguredWidgetHostnames(
  value: unknown,
): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_HOSTNAMES) return null;

  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const normalized = normalizeHostHeader(entry);
    if (!normalized || normalized !== entry || seen.has(entry)) return null;
    seen.add(entry);
  }

  return Array.from(seen);
}

export function isWidgetOriginAllowed(
  origin: NormalizedWidgetOrigin,
  configuredHostnames: readonly string[],
): boolean {
  return configuredHostnames.includes(origin.hostname);
}

export function isSameOriginWidgetPreview(
  request: Request,
  origin: NormalizedWidgetOrigin,
): boolean {
  const requestOrigin = resolveWidgetRequestOrigin(request);
  return requestOrigin?.origin === origin.origin;
}

/**
 * Railway terminates TLS and Next.js may expose an internal request URL.
 * Use the actual Host (never X-Forwarded-Host) and the edge's single protocol.
 * This only identifies the request origin; preview routes must still enforce
 * authenticated workspace ownership, entitlement, and traffic controls.
 */
export function resolveWidgetRequestOrigin(
  request: Request,
): NormalizedWidgetOrigin | null {
  const rawHost = request.headers.get("host");
  const hostname = normalizeHostHeader(rawHost);
  if (!rawHost || !hostname) return null;

  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  let protocol: string;
  if (forwardedProtocol !== null) {
    if (forwardedProtocol !== "https" && forwardedProtocol !== "http") return null;
    protocol = `${forwardedProtocol}:`;
  } else {
    // Without an explicit proxy protocol, only a URL with the same host can
    // supply the scheme. Do not infer HTTPS for an internal/public mismatch.
    const url = new URL(request.url);
    if (normalizeHostHeader(url.host) !== hostname) return null;
    protocol = url.protocol;
  }

  const requestOrigin = normalizeWidgetOrigin(`${protocol}//${rawHost}`);
  return requestOrigin?.hostname === hostname ? requestOrigin : null;
}
