import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { confirmTextingUpgrade } from "@/lib/stripe/textingUpgrade.server";
import { refreshTextingUpgrade } from "@/lib/billing/textingUpgradeReconciliation.server";
import { textingUpgradeFailure } from "@/lib/billing/textingUpgradeResponse.server";
const schema = z.object({ operationId: z.string().uuid(), quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/), starterAcknowledged: z.boolean().default(false) }).strict();
export async function POST(request: NextRequest) {
  const c = await requireFreshWorkspaceRouteAccess();
  if (!c.ok) return c.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  try {
    await confirmTextingUpgrade(c.access.business.id, c.access.user.id, parsed.data.operationId, parsed.data.quoteFingerprint, parsed.data.starterAcknowledged);
    return NextResponse.json({ state: await refreshTextingUpgrade(c.access.business.id, c.access.user.id) });
  } catch (error) { return textingUpgradeFailure(error); }
}
