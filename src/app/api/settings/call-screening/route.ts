import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { getCallScreeningSettings, updateCallScreening } from "@/lib/call-screening/settings.server";

export const dynamic = "force-dynamic";
const schema = z.object({ mode: z.enum(["disabled", "flag_calls"]), revision: z.number().int().min(0) });
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const conflict = ["screening_revision_conflict", "screening_sync_pending"].includes(code);
  return NextResponse.json({ error: conflict ? "A screening change is already pending or the setting changed. Refresh before saving again." : code === "screening_access_denied" ? "Screening is not available for this workspace." : "Unable to verify call screening. Please try again." },
    { status: conflict ? 409 : code === "screening_access_denied" ? 403 : 503 });
}
export async function GET(request: NextRequest) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  try {
    return NextResponse.json(await getCallScreeningSettings(workspace.access.business.id, workspace.access.user.id, request.nextUrl.searchParams.get("refresh") === "1"), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose Off or Flag suspected spam." }, { status: 400 });
  try {
    return NextResponse.json(await updateCallScreening(workspace.access.business.id, workspace.access.user.id, parsed.data.mode, parsed.data.revision), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
