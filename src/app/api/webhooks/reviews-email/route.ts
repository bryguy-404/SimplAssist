import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyResendWebhook } from "@/lib/reviews/domain";
import { reviewRpc } from "@/lib/reviews/service.server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 256000 || !verifyResendWebhook(raw, request.headers))
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  try {
    const event = JSON.parse(raw);
    const providerId = event.data?.email_id;
    if (
      typeof providerId !== "string" ||
      ![
        "email.sent",
        "email.delivered",
        "email.failed",
        "email.bounced",
        "email.complained",
        "email.suppressed",
      ].includes(event.type)
    )
      return NextResponse.json({ received: true });
    const occurredAt = new Date(event.created_at);
    if (!Number.isFinite(occurredAt.getTime()))
      return NextResponse.json({ error: "invalid_event" }, { status: 400 });
    const tags = event.data?.tags;
    const delivery = Array.isArray(tags)
      ? tags.find((t: { name?: string }) => t.name === "review_delivery")?.value
      : tags?.review_delivery;
    const deliveryId =
      typeof delivery === "string" && /^[0-9a-f-]{36}$/i.test(delivery)
        ? delivery
        : null;
    const { error } = await supabaseAdmin
      .from("review_email_provider_events")
      .upsert(
        {
          event_id: request.headers.get("svix-id"),
          provider_message_id: providerId,
          delivery_id: deliveryId,
          event_type: event.type,
          occurred_at: occurredAt.toISOString(),
        },
        { onConflict: "event_id", ignoreDuplicates: true },
      );
    if (error) throw error;
    await reviewRpc("review_apply_email_events");
    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json(
      { error: "event_persistence_failed" },
      { status: 503 },
    );
  }
}
