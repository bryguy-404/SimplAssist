import { NextResponse } from "next/server";
import { z } from "zod";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getDashboardUpgradePrompt } from "@/lib/dashboard/upgradePrompt.server";
import { UPGRADE_OFFER_KEYS } from "@/lib/dashboard/upgradePrompt";

export const dynamic = "force-dynamic";
const preferenceSchema = z.object({ offerKey: z.enum(UPGRADE_OFFER_KEYS), action: z.enum(["snooze", "hide"]), expectedRevision: z.number().int().min(0).max(2147483646) }).strict();
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function GET() {
  const access = await requireFreshWorkspaceRouteAccess();
  if (!access.ok) return access.response;
  return json({ prompt: await getDashboardUpgradePrompt(access.access.business.id, access.access.user.id) });
}
export async function POST(request: Request) {
  const access = await requireFreshWorkspaceRouteAccess();
  if (!access.ok) return access.response;
  let parsed;
  try {
    const body = await request.text();
    if (body.length > 1000) return json({ error: "upgrade_prompt_invalid" }, 400);
    parsed = preferenceSchema.safeParse(JSON.parse(body));
  } catch { return json({ error: "upgrade_prompt_invalid" }, 400); }
  if (!parsed.success) return json({ error: "upgrade_prompt_invalid" }, 400);
  const { business, user } = access.access;
  const prompt = await getDashboardUpgradePrompt(business.id, user.id);
  if (!prompt || prompt.kind !== "offer" || prompt.offerKey !== parsed.data.offerKey || prompt.revision !== parsed.data.expectedRevision) return json({ error: "upgrade_prompt_changed" }, 409);
  const { error } = await supabaseAdmin.rpc("save_dashboard_upgrade_preference", {
    p_business_id: business.id, p_owner_id: user.id, p_offer_key: parsed.data.offerKey,
    p_action: parsed.data.action, p_expected_revision: parsed.data.expectedRevision,
  });
  if (error) return json({ error: error.code === "40001" ? "upgrade_prompt_changed" : "upgrade_prompt_save_failed" }, error.code === "40001" ? 409 : 503);
  return json({ success: true });
}
