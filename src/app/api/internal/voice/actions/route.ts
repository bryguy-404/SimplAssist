import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { actionDecision } from "@/lib/voice/actions";
import {
  loadVoiceActionContext,
  runVoiceDecision,
} from "@/lib/voice/actionService.server";
import { supabaseAdmin } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const schema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("context"), sessionId: z.string().uuid() })
    .strict(),
  z
    .object({
      operation: z.literal("decision"),
      sessionId: z.string().uuid(),
      decision: actionDecision,
    })
    .strict(),
  z
    .object({
      operation: z.literal("playback"),
      sessionId: z.string().uuid(),
      actionId: z.string().uuid(),
      eventId: z.string().min(1).max(200),
      callerEndMs: z.number().int().nonnegative(),
    })
    .strict(),
]);
export async function POST(request: NextRequest) {
  const token = process.env.VOICE_INTERNAL_TOKEN || "";
  const actual = Buffer.from(request.headers.get("authorization") || ""),
    expected = Buffer.from(`Bearer ${token}`);
  if (
    token.length < 32 ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return new NextResponse("Not found", { status: 404 });
  const json = await request.text();
  if (json.length > 32000)
    return new NextResponse("Too large", { status: 413 });
  try {
    const input = schema.parse(JSON.parse(json));
    if (input.operation === "playback") {
      const { error } = await supabaseAdmin.rpc("mark_voice_action_playback", {
        p_session_id: input.sessionId,
        p_action_id: input.actionId,
        p_event_id: input.eventId,
        p_caller_end_ms: input.callerEndMs,
      });
      if (error) throw new Error("voice_playback_save_failed");
      return NextResponse.json(
        { ok: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (input.operation === "context") {
      const c = await loadVoiceActionContext(input.sessionId);
      return NextResponse.json(
        {
          sessionId: c.session.id,
          actionBusinessId:
            c.session.action_business_id || c.session.business_id,
          demo: !!c.session.demo_mode,
          capabilities: c.capabilities,
          goal: c.business.primary_goal,
          bookingMode: c.settings.booking_mode,
          timezone: c.business.timezone,
          callerPhone: c.session.caller_phone,
          spokenSignupInstructions:
            c.session.business_id === "ea848911-ef72-44a6-8cf3-c47b3959be26" &&
            c.business.goal_url === "https://simplassist.com/signup"
              ? "You can visit simplassist.com and choose Get Started."
              : null,
          actions: c.actions,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      await runVoiceDecision(input.sessionId, input.decision),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "voice_action_unavailable" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
}
