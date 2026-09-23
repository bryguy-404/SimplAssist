import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { TextingUpgradeError } from "@/lib/billing/textingUpgrade";
import { textingUpgradeFailure } from "@/lib/billing/textingUpgradeResponse.server";
import { getTextingUpgradeState, loadTextingUpgradeContext, selectTextingUpgrade } from "@/lib/billing/textingUpgrade.server";
import { saveTextingUpgradeForm } from "@/lib/billing/textingUpgradeForms.server";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("select"), plan: z.enum(["sms_only", "sms_and_chat", "full"]), starterAcknowledged: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("save"), step: z.enum(["business", "verification", "use_case", "phone"]), values: z.record(z.string(), z.unknown()) }).strict(),
]);
export async function GET() {
  const context = await requireFreshWorkspaceRouteAccess();
  if (!context.ok) return context.response;
  try { return NextResponse.json({ state: await getTextingUpgradeState(context.access.business.id, context.access.user.id) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return textingUpgradeFailure(error); }
}
export async function POST(request: NextRequest) {
  const context = await requireFreshWorkspaceRouteAccess();
  if (!context.ok) return context.response;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const businessId = context.access.business.id, ownerId = context.access.user.id;
  try {
    if (parsed.data.action === "select") await selectTextingUpgrade(businessId, ownerId, parsed.data.plan, parsed.data.starterAcknowledged);
    else {
      const c = await loadTextingUpgradeContext(businessId, ownerId);
      if (!c.upgrade || !c.eligible) throw new TextingUpgradeError("texting_upgrade_support_required");
      await saveTextingUpgradeForm({ upgrade: c.upgrade, businessId, ownerId, step: parsed.data.step, values: parsed.data.values });
    }
    return NextResponse.json({ state: await getTextingUpgradeState(businessId, ownerId) });
  } catch (error) { return textingUpgradeFailure(error); }
}
