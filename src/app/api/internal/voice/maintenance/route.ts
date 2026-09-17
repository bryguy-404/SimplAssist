import { reconcileBookingSummarySends } from '@/lib/booking/summarySend.server';
import { reconcileBookingNotifications } from '@/lib/booking/notifications.server';
import { isBookingConfirmationEnabled } from '@/lib/booking/draft';
import { reconcileBookingDrafts } from '@/lib/booking/recovery.server';
import { recoverVoiceActions } from "@/lib/voice/actionRecovery.server";
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { pilotRoutingDependencies } from "@/lib/voice/routing.server";
import { drainFallback } from "@/lib/voice/routing";
import { maintainVoicePilot } from "@/lib/voice/maintenance";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const token = process.env.VOICE_INTERNAL_TOKEN || "";
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.get("authorization") || "");
  if (
    token.length < 32 ||
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  )
    return new NextResponse("Not found", { status: 404 });
  const deps = pilotRoutingDependencies();
  try {
    await maintainVoicePilot(deps.db, deps.telnyx, (id) =>
      drainFallback(deps, id),
    );
    if (process.env.VOICE_ACTIONS_ROLLOUT === "true")
      await recoverVoiceActions();
    if (isBookingConfirmationEnabled()) { await reconcileBookingDrafts(); await reconcileBookingNotifications(); await reconcileBookingSummarySends(); }
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Voice maintenance needs retry" },
      { status: 503 },
    );
  }
}
