import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { canUseFeature, resolveBusinessEntitlements } from "@/lib/billing/entitlements";
import { supabaseAdmin } from "@/lib/supabase/admin";

const schema = z.object({ decision: z.enum(["spam", "not_spam"]), revision: z.number().int().min(0) });
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!z.string().uuid().safeParse(params.id).success || !parsed.success) return NextResponse.json({ error: "Invalid call review." }, { status: 400 });
  const { business, user } = workspace.access;
  try {
    if (!canUseFeature(await resolveBusinessEntitlements(business.id), "contacts_inbox")) return NextResponse.json({ error: "Call review is unavailable on the current plan." }, { status: 403 });
    const { data, error } = await supabaseAdmin.rpc("review_inbox_call_spam", {
      p_business: business.id, p_owner: user.id, p_conversation: params.id, p_decision: parsed.data.decision, p_revision: parsed.data.revision,
    });
    if (error) {
      const conflicts: Record<string, string> = {
        screening_revision_conflict: "This call changed. Refresh the inbox and review it again.",
        screening_call_active: "Wait until this call has ended before reviewing it.",
        screening_call_not_found: "This call is no longer available. Refresh the inbox.",
      };
      if (error.code === "42501") return NextResponse.json({ error: "Call access is no longer available." }, { status: 403 });
      if (conflicts[error.message]) return NextResponse.json({ error: conflicts[error.message] }, { status: 409 });
      throw error;
    }
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Unable to save this review. Please try again." }, { status: 503 }); }
}
