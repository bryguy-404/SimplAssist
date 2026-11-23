import { NextRequest, NextResponse } from "next/server";
import { deleteConversations } from "@/lib/conversations/delete.server";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { decodeInboxCursor, inboxQuerySchema, readInboxPage } from "@/lib/conversations/inbox.server";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  const parsed = inboxQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid inbox filter." }, { status: 400 });
  try { decodeInboxCursor(parsed.data.cursor); }
  catch { return NextResponse.json({ error: "Invalid inbox page. Return to the first page." }, { status: 400 }); }
  try {
    return NextResponse.json(await readInboxPage(workspace.access.business.id, workspace.access.user.id, parsed.data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: "Unable to load conversations. Please refresh." }, { status: error instanceof Error && error.message === "inbox_access_denied" ? 403 : 503 });
  }
}

export async function DELETE(request: NextRequest) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid deletion request." }, { status: 400 });
  }
  return deleteConversations(body?.ids, body?.folder);
}
