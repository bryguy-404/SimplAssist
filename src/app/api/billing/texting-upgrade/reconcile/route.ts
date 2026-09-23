import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { reconcilePendingTextingUpgrades } from "@/lib/billing/textingUpgradeReconciliation.server";
export const maxDuration = 30;
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  const match = expected ? `Bearer ${expected}` : "";
  if (!expected || Buffer.byteLength(supplied) !== Buffer.byteLength(match) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(match)))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await reconcilePendingTextingUpgrades();
    return NextResponse.json(result, { status: result.failed ? 503 : result.deferred ? 202 : 200 });
  } catch { return NextResponse.json({ error: "texting_upgrade_reconciliation_unavailable" }, { status: 503 }); }
}
