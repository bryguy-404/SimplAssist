import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { reconcilePendingBrandRegistrations } from "@/lib/onboarding/continueRegistration.server";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const token = process.env.VOICE_INTERNAL_TOKEN || "";
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.get("authorization") || "");
  if (token.length < 32 || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return new NextResponse("Not found", { status: 404 });
  try {
    const result = await reconcilePendingBrandRegistrations();
    return NextResponse.json(result, { status: result.failed ? 503 : 200,
      headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Registration check needs retry" }, { status: 503 });
  }
}
