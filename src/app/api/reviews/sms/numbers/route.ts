import { NextResponse } from "next/server";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import { resolveBusinessEntitlements } from "@/lib/billing/entitlements";
import { searchAvailableNumbers } from "@/lib/messaging/numbers";
export async function GET(request: Request) {
  const access = await requireFreshWorkspaceRouteAccess();
  if (!access.ok) return access.response;
  const businessId = access.access.business.id;
  if (!isReviewSmsEnabled(businessId))
    return NextResponse.json({ error: "review_sms_disabled" }, { status: 404 });
  const areaCode = new URL(request.url).searchParams.get("areaCode") ?? "";
  if (!/^[2-9]\d{2}$/.test(areaCode))
    return NextResponse.json({ error: "invalid_area_code" }, { status: 400 });
  try {
    if (!(await resolveBusinessEntitlements(businessId)).active)
      return NextResponse.json({ error: "billing_required" }, { status: 403 });
    return NextResponse.json(
      { numbers: await searchAvailableNumbers(areaCode) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "number_search_unavailable" },
      { status: 503 },
    );
  }
}
