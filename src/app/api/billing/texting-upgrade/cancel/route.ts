import { NextResponse } from "next/server";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { getTextingUpgradeState } from "@/lib/billing/textingUpgrade.server";
import { cancelTextingUpgrade } from "@/lib/stripe/textingUpgrade.server";
import { textingUpgradeFailure } from "@/lib/billing/textingUpgradeResponse.server";
export async function POST() {
  const c = await requireFreshWorkspaceRouteAccess();
  if (!c.ok) return c.response;
  try {
    await cancelTextingUpgrade(c.access.business.id, c.access.user.id);
    return NextResponse.json({ state: await getTextingUpgradeState(c.access.business.id, c.access.user.id) });
  } catch (error) { return textingUpgradeFailure(error); }
}
