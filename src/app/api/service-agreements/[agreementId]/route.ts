import { NextRequest } from "next/server";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { serviceAgreementDownload } from "@/lib/agreements/download.server";

export async function GET(request: NextRequest, { params }: { params: { agreementId: string } }) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  // No subscription entitlement check: canceled subscribers retain access.
  return serviceAgreementDownload(workspace.access.business.id, params.agreementId, request.nextUrl.searchParams.get("download") === "1");
}
