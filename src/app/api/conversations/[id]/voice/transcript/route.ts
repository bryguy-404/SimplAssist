import { NextRequest, NextResponse } from "next/server";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { loadVoiceCallTranscript } from "@/lib/voice/callTranscript.server";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
  try {
    const transcript = await loadVoiceCallTranscript(workspace.access.business.id, params.id);
    if (!transcript) return NextResponse.json({ error: "Call not found" }, { status: 404, headers });
    return NextResponse.json({ transcript }, { headers });
  } catch {
    return NextResponse.json({ error: "Call transcript is temporarily unavailable", retryable: true }, { status: 503, headers });
  }
}
