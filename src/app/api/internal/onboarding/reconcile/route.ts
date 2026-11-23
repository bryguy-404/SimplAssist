import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { reconcilePendingBrandRegistrations } from "@/lib/onboarding/continueRegistration.server";
import { runAccountSignupAlerts } from "@/lib/account-alerts/runner.server";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const token = process.env.VOICE_INTERNAL_TOKEN || "";
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.get("authorization") || "");
  if (token.length < 32 || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return new NextResponse("Not found", { status: 404 });
  try {
    // Both jobs run even if the other fails. Email cannot block carrier work.
    const [registration, alerts] = await Promise.allSettled([
      reconcilePendingBrandRegistrations(), runAccountSignupAlerts(),
    ]);
    if (alerts.status === "rejected") console.warn("[account-alerts] background delivery needs retry");
    if (registration.status === "rejected") throw new Error("registration_check_failed");
    const result = registration.value;
    const accountAlerts = alerts.status === "fulfilled" ? alerts.value : { error: "Account alerts need retry" };
    const alertFailure = alerts.status === "rejected" || (alerts.status === "fulfilled" && (alerts.value.retry > 0 || alerts.value.needsReview > 0));
    return NextResponse.json({ ...result, accountAlerts }, { status: result.failed || alertFailure ? 503 : 200,
      headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Registration check needs retry" }, { status: 503 });
  }
}
