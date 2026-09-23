import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { adminUserIds } from "@/lib/admin/allowlist";
import { isAdminPath } from "@/lib/admin/adminPath";
import { isCanonicalAdminHostname } from "@/lib/admin/canonicalHost";
import { ADMIN_AUTH_COOKIE_OPTIONS } from "@/lib/admin/sessionCookie";
import {
  BRAND_PREVIEW_COOKIE,
  BRAND_PREVIEW_HEADER,
} from "@/lib/branding/types";
import { isValidPartnerSlug } from "@/lib/branding/hostname";

const PREVIEW_COOKIE_MAX_AGE_SECONDS = 30 * 60;

const PREVIEW_COOKIE_OPTIONS: CookieOptions = {
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
};

type PreviewIntent = {
  isPreviewRequest: boolean;
  slug: string | null;
  persistOnAuthorize: boolean;
};

function isPreviewPageRequest(request: NextRequest): boolean {
  const { pathname } = request.nextUrl;
  const isPageMethod = request.method === "GET" || request.method === "HEAD";
  const isApiPath = pathname === "/api" || pathname.startsWith("/api/");

  // Public route handlers resolve their own invariant destinations/cache rules.
  // Brand preview must never influence SMS dashboard navigation.
  return isPageMethod && !isApiPath && pathname !== "/widget/embed.js" &&
    !pathname.startsWith("/booking-alerts/open/");
}

function countRawCookies(request: NextRequest, cookieName: string): number {
  const rawCookieHeader = request.headers.get("cookie");
  if (!rawCookieHeader) return 0;

  return rawCookieHeader.split(";").reduce((count, pair) => {
    const equalsIndex = pair.indexOf("=");
    const name = (
      equalsIndex === -1 ? pair : pair.slice(0, equalsIndex)
    ).trim();
    return name === cookieName ? count + 1 : count;
  }, 0);
}

function previewIntent(request: NextRequest): PreviewIntent {
  if (!isPreviewPageRequest(request)) {
    return { isPreviewRequest: false, slug: null, persistOnAuthorize: false };
  }

  const queryValues = request.nextUrl.searchParams.getAll("brand");
  if (queryValues.length > 0) {
    const slug = queryValues.length === 1 ? queryValues[0] : null;
    if (!slug || !isValidPartnerSlug(slug)) {
      return { isPreviewRequest: true, slug: null, persistOnAuthorize: false };
    }

    return { isPreviewRequest: true, slug, persistOnAuthorize: true };
  }

  const previewCookies = request.cookies.getAll(BRAND_PREVIEW_COOKIE);
  const rawPreviewCookieCount = countRawCookies(request, BRAND_PREVIEW_COOKIE);
  const slug =
    rawPreviewCookieCount === 1 && previewCookies.length === 1
      ? previewCookies[0].value
      : null;
  if (rawPreviewCookieCount === 0 && previewCookies.length === 0) {
    return { isPreviewRequest: false, slug: null, persistOnAuthorize: false };
  }
  if (!slug || !isValidPartnerSlug(slug)) {
    return { isPreviewRequest: true, slug: null, persistOnAuthorize: false };
  }

  return { isPreviewRequest: true, slug, persistOnAuthorize: false };
}

function addVaryCookie(headers: Headers) {
  const vary = headers.get("Vary");
  const values = vary
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!values?.some((value) => value.toLowerCase() === "cookie")) {
    headers.set(
      "Vary",
      values?.length ? `${values.join(", ")}, Cookie` : "Cookie",
    );
  }
}

function isCanonicalPreviewHost(request: NextRequest): boolean {
  return isCanonicalAdminHostname(request.headers.get("host"));
}

// Refreshes both auth channels: the customer session (default sb-* cookies,
// every matched path) and the admin session (sa-admin-auth cookies, admin
// paths and authorized preview requests). The two clients write disjoint
// cookie names, but they must share ONE response: the canonical per-client
// pattern recreates the
// response inside setAll, which would drop the first client's rotated
// tokens — and a dropped Set-Cookie after refresh-token rotation kills that
// session. So each setAll only mutates the request (downstream server
// components read from it) and queues the write; the response is built once
// at the end with every queued cookie applied.
export async function updateSession(request: NextRequest) {
  const pendingCookies: {
    name: string;
    value: string;
    options: CookieOptions;
  }[] = [];

  const makeClient = (cookieOptions?: { name: string; secure: boolean }) =>
    createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        ...(cookieOptions ? { cookieOptions } : {}),
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            );
            pendingCookies.push(...cookiesToSet);
          },
        },
      }
    );

  // Middleware only refreshes the customer session. Route and page guards
  // still authorize with getUser(); no decision here trusts cookie claims.
  await makeClient().auth.getClaims();

  const preview = previewIntent(request);
  const previewHostIsCanonical = isCanonicalPreviewHost(request);
  let trustedPreviewSlug: string | null = null;
  let previewCookieAction: "none" | "set" | "clear" =
    preview.isPreviewRequest && (!preview.slug || !previewHostIsCanonical)
      ? "clear"
      : "none";

  if (
    isAdminPath(request.nextUrl.pathname) ||
    (previewHostIsCanonical && preview.slug)
  ) {
    const adminClient = makeClient(ADMIN_AUTH_COOKIE_OPTIONS);
    const {
      data: { user },
      error: userError,
    } = await adminClient.auth.getUser();
    const allowedAdminIds = adminUserIds();
    const allowedAdmin = !userError && !!user && allowedAdminIds.has(user.id);

    if (previewHostIsCanonical && preview.slug) {
      if (allowedAdmin) {
        trustedPreviewSlug = preview.slug;
        previewCookieAction = preview.persistOnAuthorize ? "set" : "none";
      } else {
        previewCookieAction = "clear";
      }
    }

    // A signed-in admin-channel user who is not allowlisted is signed out
    // immediately (scope "local": revokes only this session, clears only the
    // admin cookies), so a failed admin sign-in never leaves a session
    // behind. auth-js RETURNS errors rather than throwing, so check the
    // result; on failure the session lingers but every downstream gate
    // still fails closed to 404.
    if (user && !allowedAdminIds.has(user.id)) {
      const { error } = await adminClient.auth.signOut({ scope: "local" });
      if (error) {
        console.error(
          "[admin-auth] Failed to revoke non-allowlisted admin-channel session:",
          error.message
        );
      }
    }
  }

  // Rebuild the downstream request headers after auth refresh so rotated
  // customer/admin cookies are included. The client can never supply the
  // internal preview header; only an authorized admin preview restores it.
  const downstreamHeaders = new Headers(request.headers);
  downstreamHeaders.delete(BRAND_PREVIEW_HEADER);
  if (trustedPreviewSlug) {
    downstreamHeaders.set(BRAND_PREVIEW_HEADER, trustedPreviewSlug);
  }

  const response = NextResponse.next({
    request: { headers: downstreamHeaders },
  });
  pendingCookies.forEach(({ name, value, options }) =>
    response.cookies.set(name, value, options)
  );

  if (previewCookieAction === "set" && trustedPreviewSlug) {
    response.cookies.set(BRAND_PREVIEW_COOKIE, trustedPreviewSlug, {
      ...PREVIEW_COOKIE_OPTIONS,
      maxAge: PREVIEW_COOKIE_MAX_AGE_SECONDS,
    });
  } else if (previewCookieAction === "clear") {
    response.cookies.set(BRAND_PREVIEW_COOKIE, "", {
      ...PREVIEW_COOKIE_OPTIONS,
      maxAge: 0,
    });
  }

  if (preview.isPreviewRequest) {
    response.headers.set("Cache-Control", "private, no-store");
    addVaryCookie(response.headers);
  }

  return response;
}
