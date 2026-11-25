import { NextResponse } from "next/server";
import { z } from "zod";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { feedbackRatings } from "@/lib/feedback/client";
import { deliverFeedbackEmail } from "@/lib/feedback/delivery.server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const actions = z.discriminatedUnion("action", [
  z.object({ action: z.literal("activity") }).strict(),
  z.object({ action: z.literal("visit"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("dismiss"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("submit"), id: z.uuid(), rating: z.enum(feedbackRatings), comment: z.string().trim().max(1500) }).strict(),
]);

export async function POST(request: Request) {
  const access = await requireFreshWorkspaceRouteAccess();
  if (!access.ok) return access.response;
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "Expected JSON" }, { status: 415 });
  }
  const action = actions.safeParse(await request.json().catch(() => null));
  if (!action.success) return NextResponse.json({ error: "Invalid feedback request" }, { status: 400 });

  const { business, user } = access.access;
  const input = action.data;
  const { data, error } = await supabaseAdmin.rpc("dashboard_feedback_action", {
    p_business: business.id, p_owner: user.id, p_action: input.action,
    ...("id" in input && { p_id: input.id }),
    ...(input.action === "submit" && { p_rating: input.rating, p_comment: input.comment, p_email: user.email ?? null }),
  });
  if (error) return NextResponse.json({ error: "Feedback unavailable" }, { status: 503 });
  if (data === "slow_down") return NextResponse.json({ error: "Please wait a minute" }, { status: 429 });
  if (input.action === "submit") {
    // The response is durable. A failed immediate delivery is retried by the heartbeat.
    await deliverFeedbackEmail(input.id).catch(() => console.warn("[feedback] email queued for retry"));
  }
  return NextResponse.json({ result: data });
}
