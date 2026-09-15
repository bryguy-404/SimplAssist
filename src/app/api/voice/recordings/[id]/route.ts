import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin/auth";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { proxyVoiceRecording } from "@/lib/voice/recording";

export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const admin = await getAdminUser();
  let businessId: string | null = null;
  if (!admin) {
    const workspace = await requireFreshWorkspaceRouteAccess();
    if (!workspace.ok) return workspace.response;
    businessId = workspace.access.business.id;
  }
  const query = supabaseAdmin
    .from("voice_recordings")
    .select("recording_id,session_id,business_id,delete_after,deleted_at")
    .eq("recording_id", params.id);
  const { data: recording, error } = await (
    businessId ? query.eq("business_id", businessId) : query
  ).maybeSingle();
  if (error)
    return NextResponse.json(
      { error: "Recording lookup unavailable" },
      { status: 503 },
    );
  if (
    !recording ||
    recording.deleted_at ||
    Date.parse(recording.delete_after) <= Date.now()
  )
    return new NextResponse("Not found", { status: 404 });
  const { data: session, error: sessionError } = await supabaseAdmin
    .from("voice_sessions")
    .select("call_control_id,call_session_id")
    .eq("id", recording.session_id)
    .eq("business_id", recording.business_id)
    .single();
  if (sessionError || !session)
    return new NextResponse("Not found", { status: 404 });
  try {
    return await proxyVoiceRecording(
      telnyx,
      recording.recording_id,
      session,
      request.headers.get("range"),
    );
  } catch {
    return new NextResponse("Recording unavailable", { status: 502 });
  }
}
