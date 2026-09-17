import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { cancelSmsBillingOperation, confirmSmsPlanChange, previewSmsPlanChange, readSmsBillingChange, SmsBillingError } from "@/lib/stripe/smsBilling.server";

const previewSchema = z.object({ plan: z.enum(["sms_only", "sms_and_chat", "full"]) }).strict();
const operationSchema = z.object({ operationId: z.string().uuid() }).strict();
function failure(error: unknown) {
  if (error instanceof SmsBillingError) return NextResponse.json({ error: error.code }, { status: error.httpStatus });
  return NextResponse.json({ error: "sms_billing_unavailable" }, { status: 503 });
}
async function context() {
  return requireWorkspaceRouteAccess();
}
export async function GET(request: NextRequest) {
  const workspace = await context();
  if (!workspace.ok) return workspace.response;
  const value = request.nextUrl.searchParams.get("operationId");
  if (value && !z.string().uuid().safeParse(value).success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  try { return NextResponse.json({ change: await readSmsBillingChange(workspace.access.business.id, workspace.access.user.id, value ?? undefined) }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const workspace = await context();
  if (!workspace.ok) return workspace.response;
  const parsed = previewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  try { return NextResponse.json({ change: await previewSmsPlanChange(workspace.access.business.id, workspace.access.user.id, parsed.data.plan) }); }
  catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  const workspace = await context();
  if (!workspace.ok) return workspace.response;
  const parsed = operationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  try { return NextResponse.json({ change: await confirmSmsPlanChange(workspace.access.business.id, workspace.access.user.id, parsed.data.operationId) }); }
  catch (error) { return failure(error); }
}
export async function DELETE(request: NextRequest) {
  const workspace = await context();
  if (!workspace.ok) return workspace.response;
  const parsed = operationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  try {
    await cancelSmsBillingOperation(workspace.access.business.id, workspace.access.user.id, parsed.data.operationId);
    return NextResponse.json({ canceled: true });
  } catch (error) { return failure(error); }
}
