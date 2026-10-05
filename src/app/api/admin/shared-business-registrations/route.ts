import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminUser } from "@/lib/admin/auth";
import {
  approveSharedRegistration,
  inspectSharedRegistration,
  revokeSharedRegistration,
  SharedRegistrationError,
} from "@/lib/messaging/sharedBusinessRegistrations.server";

const inspection = z.object({
  sourceBusinessId: z.string().uuid(), targetBusinessId: z.string().uuid(),
  sourceOwnerId: z.string().uuid(), targetOwnerId: z.string().uuid(),
}).strict();
const actions = z.discriminatedUnion("action", [
  inspection.extend({ action: z.literal("inspect") }),
  inspection.extend({ action: z.literal("approve"), expectedRevision: z.number().int().nonnegative() }),
  z.object({ action: z.literal("revoke"), businessId: z.string().uuid(), ownerId: z.string().uuid(),
    expectedRevision: z.number().int().positive(), reason: z.string().trim().min(5).max(500) }).strict(),
]);

function errorResponse(error: unknown) {
  const known = error instanceof SharedRegistrationError;
  return NextResponse.json({
    error: known && error.code.endsWith("_disabled")
      ? "New shared-registration setup is not enabled for this account."
      : "The shared registration could not be changed safely. Inspect the account again before retrying.",
    code: known ? error.code : "shared_registration_unavailable",
  }, { status: known ? error.status : 503 });
}

export async function GET(request: NextRequest) {
  // Authenticate before parsing or looking up any account/provider identifiers.
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = inspection.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid inspection request" }, { status: 400 });
  try {
    return NextResponse.json({ inspection: await inspectSharedRegistration(parsed.data) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  const admin = await getAdminUser();
  if (!admin) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = actions.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid registration request" }, { status: 400 });
  try {
    const input = parsed.data;
    if (input.action === "inspect") return NextResponse.json({ inspection: await inspectSharedRegistration(input) });
    if (input.action === "approve") {
      return NextResponse.json({ inspection: await approveSharedRegistration({ ...input, actorId: admin.id }) });
    }
    await revokeSharedRegistration({ ...input, actorId: admin.id });
    return NextResponse.json({ success: true });
  } catch (error) { return errorResponse(error); }
}
