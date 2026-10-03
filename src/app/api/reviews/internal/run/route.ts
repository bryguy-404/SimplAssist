import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runReviewAutomationWorker } from "@/lib/reviews/automation-worker.server";
import { runReviewSmsWorker } from "@/lib/reviews/sms-worker.server";
import { runReviewEmailWorker } from "@/lib/reviews/worker.server";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const key = process.env.REVIEWS_WORKER_TOKEN ?? "";
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${key}`;
  if (
    key.length < 32 ||
    supplied.length !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  )
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({
      automation: await runReviewAutomationWorker(),
      email: await runReviewEmailWorker(),
      sms: await runReviewSmsWorker(),
    });
  } catch {
    return NextResponse.json(
      { error: "review_worker_failed" },
      { status: 503 },
    );
  }
}
