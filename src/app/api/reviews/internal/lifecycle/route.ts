import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runReviewSmsLifecycle } from "@/lib/reviews/smsLifecycle.server";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const token = process.env.REVIEWS_WORKER_TOKEN ?? "",
    given = request.headers.get("authorization") ?? "",
    expected = `Bearer ${token}`;
  if (
    token.length < 32 ||
    given.length !== expected.length ||
    !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  )
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runReviewSmsLifecycle());
  } catch {
    return NextResponse.json(
      { error: "review_lifecycle_failed" },
      { status: 503 },
    );
  }
}
