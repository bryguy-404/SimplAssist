import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { getOwnerVoiceSettings, updateOwnerVoiceSettings, VoiceSettingsError } from "@/lib/voice/access.server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
const updateSchema = z.object({
  mode: z.enum(["text", "voice"]), textFallbackEnabled: z.boolean(), expectedRevision: z.number().int().nonnegative(),
}).strict();

function failure(error: unknown) {
  if (error instanceof VoiceSettingsError) {
    if (error.code === "conflict") return NextResponse.json({ error: "Settings changed. Refresh and try again." }, { status: 409, headers });
    if (error.code === "forbidden") return NextResponse.json({ error: "Voice is not available for this account." }, { status: 403, headers });
  }
  return NextResponse.json({ error: "Voice settings are temporarily unavailable.", retryable: true }, { status: 503, headers });
}

export async function GET() {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  try {
    return NextResponse.json({ voice: await getOwnerVoiceSettings(workspace.access.business.id) }, { headers });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: NextRequest) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid voice settings" }, { status: 400, headers });
  try {
    const voice = await updateOwnerVoiceSettings(workspace.access.business.id, workspace.access.user.id, parsed.data);
    return NextResponse.json({ voice }, { headers });
  } catch (error) { return failure(error); }
}
