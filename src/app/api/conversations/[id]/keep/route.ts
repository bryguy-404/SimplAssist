import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { canUseFeature, resolveBusinessEntitlements } from "@/lib/billing/entitlements";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function PATCH(_request: NextRequest, { params }: { params: { id: string } }) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  if (!z.string().uuid().safeParse(params.id).success) return NextResponse.json({ error: "Invalid conversation." }, { status: 400 });
  const { business, user } = workspace.access;
  try {
    if (!canUseFeature(await resolveBusinessEntitlements(business.id), "contacts_inbox")) {
      return NextResponse.json({ error: "Inbox changes are unavailable on the current plan." }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Unable to check inbox access. Please try again." }, { status: 503 });
  }
  try {
    const { error } = await supabaseAdmin.rpc("keep_inbox_conversation", { p_business: business.id, p_owner: user.id, p_id: params.id });
    if (error?.code === "42501") return NextResponse.json({ error: "Conversation access is no longer available." }, { status: 403 });
    if (error?.message === "conversation_selection_changed") return NextResponse.json({ error: "This conversation changed. Refresh and try again." }, { status: 409 });
    if (error) throw error;
  } catch {
    return NextResponse.json({ error: "Unable to move this conversation. Please try again." }, { status: 503 });
  }
  return NextResponse.json({ folder: "inbox" }, { headers: { "Cache-Control": "no-store" } });
}
