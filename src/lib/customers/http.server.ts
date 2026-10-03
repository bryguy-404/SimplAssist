import "server-only";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireFreshWorkspaceRouteAccess,
  requireWorkspaceRouteAccess,
} from "@/lib/customer/workspaceRouteResponse.server";
import {
  CustomerError,
  ensureCustomerScope,
  type CustomerScope,
} from "./service.server";
import { customerWorkspaceEnabled } from "@/lib/billing/customerReviewsRollout.server";

export async function customerRoute(
  mutation: boolean,
  run: (scope: CustomerScope) => Promise<unknown>,
) {
  try {
    const access = await (mutation
      ? requireFreshWorkspaceRouteAccess()
      : requireWorkspaceRouteAccess());
    if (!access.ok) return access.response;
    const scope = {
      businessId: access.access.business.id,
      ownerId: access.access.user.id,
    };
    if (!customerWorkspaceEnabled(scope.businessId))
      throw new CustomerError("customer_workspace_not_enabled", 404);
    await ensureCustomerScope(scope);
    const result = await run(scope);
    if (result instanceof Response) return result;
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      return NextResponse.json(
        {
          error: "customer_invalid_request",
          details: error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      );
    if (error instanceof CustomerError)
      return NextResponse.json({ error: error.code }, { status: error.status });
    console.error("Customer workspace request failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    return NextResponse.json(
      { error: "customer_service_unavailable" },
      { status: 503 },
    );
  }
}
export const customerId = (value: string) => z.string().uuid().parse(value);
export async function customerJson(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json")
  )
    throw new CustomerError("customer_json_required", 415);
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes)
    throw new CustomerError("customer_request_too_large", 413);
  if (!request.body) throw new CustomerError("customer_invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new CustomerError("customer_request_too_large", 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
  } catch {
    throw new CustomerError("customer_invalid_request");
  }
}
