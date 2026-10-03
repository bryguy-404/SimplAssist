import "server-only";
import { NextResponse } from "next/server";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { requireReviewPilot, ReviewError } from "./service.server";
export async function reviewRoute(
  action: (businessId: string, ownerId: string) => Promise<unknown>,
) {
  const access = await requireFreshWorkspaceRouteAccess();
  if (!access.ok) return access.response;
  try {
    requireReviewPilot(access.access.business.id);
    return NextResponse.json(
      await action(access.access.business.id, access.access.user.id),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ReviewError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    return NextResponse.json(
      { error: "review_request_failed" },
      { status: 500 },
    );
  }
}
export async function reviewRequestBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > 100000)
    throw new ReviewError("review_request_too_large", 413);
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw new ReviewError("invalid_review_request");
  }
}
