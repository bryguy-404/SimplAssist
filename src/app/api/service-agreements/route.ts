import { NextRequest, NextResponse } from "next/server";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { requireServiceAgreement, serviceAgreementStatus } from "@/lib/agreements/service.server";
import { serviceAgreementFailure } from "@/lib/agreements/response";

export async function GET() {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  try {
    return NextResponse.json(await serviceAgreementStatus(workspace.access.business.id, workspace.access.user.id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return serviceAgreementFailure(error); }
}
export async function POST(request: NextRequest) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  try {
    const body = await request.json().catch(() => null);
    await requireServiceAgreement(workspace.access.business.id, workspace.access.user.id, body?.serviceAgreement, "billing_settings");
    return NextResponse.json(await serviceAgreementStatus(workspace.access.business.id, workspace.access.user.id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return serviceAgreementFailure(error); }
}
