import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  decideFeatureAccess,
  isEntitlementResolutionError,
  resolveBusinessEntitlements,
} from "@/lib/billing/entitlements";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const workspace = await requireWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;

  const supabase = await createClient();
  const { business } = workspace.access;

  // Verify conversation belongs to this business
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id, channel")
    .eq("id", params.id)
    .eq("business_id", business.id)
    .maybeSingle();

  if (conversationError) {
    console.error("[conversations] Conversation lookup failed:", conversationError);
    return NextResponse.json(
      { error: "Unable to verify conversation", retryable: true },
      { status: 503 }
    );
  }

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  if (conversation.channel === "voice") {
    return NextResponse.json({ error: "Voice call history is read-only" }, { status: 403 });
  }

  try {
    const entitlements = await resolveBusinessEntitlements(business.id);
    const access = decideFeatureAccess(
      entitlements,
      conversation.channel === "web_chat" ? "web_chat" : "contacts_inbox"
    );
    if (!access.allowed) {
      return NextResponse.json(
        { error: "This conversation is read-only on the current plan" },
        { status: 403 }
      );
    }
  } catch (error) {
    if (isEntitlementResolutionError(error)) {
      console.error("[conversations] Entitlement lookup failed:", error);
      return NextResponse.json(
        { error: "Unable to verify plan access", retryable: true },
        { status: 503 }
      );
    }
    throw error;
  }

  const { error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", params.id);

  if (error) {
    console.error("[conversations] Delete error:", error);
    return NextResponse.json(
      { error: "Failed to delete conversation" },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true });
}
