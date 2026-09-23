import { NextResponse } from "next/server";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { refreshTextingUpgrade } from "@/lib/billing/textingUpgradeReconciliation.server";
import { textingUpgradeFailure } from "@/lib/billing/textingUpgradeResponse.server";
export async function POST() {
  const c = await requireFreshWorkspaceRouteAccess();
  if (!c.ok) return c.response;
  try { return NextResponse.json({ state: await refreshTextingUpgrade(c.access.business.id, c.access.user.id) }); }
  catch (error) { return textingUpgradeFailure(error); }
}
