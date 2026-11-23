import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  decideFeatureAccess,
  isEntitlementResolutionError,
  resolveBusinessEntitlements,
} from "@/lib/billing/entitlements";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { inboxFolders } from "./inbox";
import { MAX_CONVERSATION_DELETE_BATCH } from "./deletion";

const idsSchema = z.array(z.string().uuid()).min(1).max(MAX_CONVERSATION_DELETE_BATCH);

/** Both deletion routes use the same authorization and completed-call checks. */
export async function deleteConversations(input: unknown, expectedFolder?: unknown) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;

  const parsed = idsSchema.safeParse(input);
  const folder = z.enum(inboxFolders).optional().safeParse(expectedFolder);
  if (!parsed.success || !folder.success) {
    return NextResponse.json(
      { error: `Select between 1 and ${MAX_CONVERSATION_DELETE_BATCH} conversations to delete.` },
      { status: 400 },
    );
  }
  const ids = Array.from(new Set(parsed.data.map((id) => id.toLowerCase())));
  const { business } = workspace.access;
  const supabase = await createClient();
  const { data: conversations, error: lookupError } = await supabase
    .from("conversations")
    .select("id, channel, status")
    .eq("business_id", business.id)
    .in("id", ids);

  if (lookupError) {
    console.error("[conversations] Deletion lookup failed:", lookupError);
    return NextResponse.json(
      { error: "Unable to verify conversations. Please try again.", retryable: true },
      { status: 503 },
    );
  }
  // Fail the entire selection before writing if any ID is missing or foreign.
  if (!conversations || conversations.length !== ids.length) {
    return NextResponse.json(
      { error: "One or more conversations were not found. Refresh and select them again." },
      { status: 404 },
    );
  }

  try {
    const entitlements = await resolveBusinessEntitlements(business.id);
    const denied = conversations.some((conversation) => !decideFeatureAccess(
      entitlements,
      conversation.channel === "web_chat" ? "web_chat" : "contacts_inbox",
    ).allowed);
    if (denied) {
      return NextResponse.json(
        { error: "One or more conversations are read-only on the current plan." },
        { status: 403 },
      );
    }
  } catch (error) {
    if (!isEntitlementResolutionError(error)) throw error;
    console.error("[conversations] Entitlement lookup failed:", error);
    return NextResponse.json(
      { error: "Unable to verify plan access. Please try again.", retryable: true },
      { status: 503 },
    );
  }

  const voice = conversations.filter((conversation) => conversation.channel === "voice");
  if (voice.some((conversation) => conversation.status !== "closed")) {
    return NextResponse.json({ error: "Calls still in progress cannot be deleted." }, { status: 409 });
  }
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  if (voice.length) {
    // Voice sessions are server-only; authorization above and the business
    // restriction below are required before reading them.
    const { data: activeCalls, error } = await supabaseAdmin.from("voice_sessions")
      .select("id")
      .eq("business_id", business.id)
      .in("conversation_id", voice.map((conversation) => conversation.id))
      .neq("status", "closed")
      .limit(1);
    if (error) {
      console.error("[conversations] Call status lookup failed:", error);
      return NextResponse.json(
        { error: "Unable to verify call status. Please try again.", retryable: true },
        { status: 503 },
      );
    }
    if (activeCalls?.length) {
      return NextResponse.json({ error: "Calls still in progress cannot be deleted." }, { status: 409 });
    }
  }

  // The service-only RPC rechecks ownership, locks the selected rows, refuses
  // active calls and linked appointments, then deletes the whole batch atomically.
  // Voice content remains read-only; usage and recording retention are unchanged.
  const { data: deleted, error } = await supabaseAdmin.rpc(folder.data ? "delete_inbox_folder_items" : "delete_inbox_conversations", {
    ...(folder.data ? { p_folder: folder.data } : {}),
    p_business_id: business.id,
    p_owner_id: workspace.access.user.id,
    p_ids: ids,
  });
  if (error) {
    const conflicts: Record<string, string> = {
      conversation_has_appointments: "Conversations with appointments are protected. Nothing was deleted. Refresh the inbox and adjust your selection.",
      conversation_call_in_progress: "A selected call is still in progress. Nothing was deleted. Please try again after it ends.",
      conversation_selection_changed: "The selected conversations have changed. Nothing was deleted. Refresh the inbox and select them again.",
    };
    if (conflicts[error.message]) {
      return NextResponse.json({ error: conflicts[error.message] }, { status: 409 });
    }
    if (error.code === "42501") {
      return NextResponse.json({ error: "Conversation access is no longer available." }, { status: 403 });
    }
    console.error("[conversations] Delete failed:", error);
    return NextResponse.json(
      { error: "Unable to delete conversations. Please try again." },
      { status: 500 },
    );
  }

  // Report the database-confirmed IDs, never just echo the requested selection.
  return NextResponse.json({ success: true, deletedIds: (deleted ?? []).map((row: { deleted_id: string }) => row.deleted_id) });
}
