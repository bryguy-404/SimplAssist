import { NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin/auth";
import { serviceAgreementDownload } from "@/lib/agreements/download.server";

export async function GET(request: NextRequest, { params }: { params: { businessId: string; agreementId: string } }) {
  if (!await getAdminUser()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return serviceAgreementDownload(params.businessId, params.agreementId, request.nextUrl.searchParams.get("download") === "1");
}
