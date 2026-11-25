import { NextRequest, NextResponse } from "next/server";
import { resolveStrictAuthCallbackOrigin } from "@/lib/auth/callbackOrigin.server";
import {
  GIFT_CODE_COOKIE,
  GIFT_CODE_COOKIE_MAX_AGE_SECONDS,
  normalizeGiftCode,
} from "@/lib/gift/code";
import { createClient } from "@/lib/supabase/server";

/**
 * The coupon page's "start" button. Remembers the code in a cookie, then sends
 * a new visitor to signup and a signed-in one back into their setup.
 *
 * The code is not checked with Stripe here: Checkout checks it again at the
 * moment it matters, and a code that has stopped working simply is not applied.
 */

export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export async function GET(
  request: NextRequest,
  { params }: { params: { code: string } },
) {
  let host: Awaited<ReturnType<typeof resolveStrictAuthCallbackOrigin>> = null;
  try {
    host = await resolveStrictAuthCallbackOrigin(request.headers.get("host"));
  } catch {
    host = null;
  }
  if (host?.kind !== "direct") {
    return new NextResponse("Not found", { status: 404, headers: HEADERS });
  }

  let signedIn = false;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    signedIn = !error && Boolean(data.user);
  } catch {
    signedIn = false;
  }

  // The destination is one of two fixed paths on the origin resolved from the
  // allow-listed Host; nothing in the request can steer it elsewhere.
  const response = NextResponse.redirect(
    `${host.origin}${signedIn ? "/dashboard" : "/signup"}`,
    { status: 303, headers: HEADERS },
  );

  const code = normalizeGiftCode(params.code);
  if (code) {
    response.cookies.set({
      name: GIFT_CODE_COOKIE,
      value: code,
      httpOnly: true,
      secure: new URL(host.origin).protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: GIFT_CODE_COOKIE_MAX_AGE_SECONDS,
    });
  }
  return response;
}
