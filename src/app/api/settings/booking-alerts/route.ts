import { NextRequest, NextResponse } from 'next/server';
import { requireFreshWorkspaceRouteAccess } from '@/lib/customer/workspaceRouteResponse.server';
import { readBoundedJsonBody } from '@/lib/http/boundedBody.server';
import { ownerBookingAlertMutationSchema } from '@/lib/owner-booking-alerts/contracts';
import { getOwnerBookingAlertSettings, mutateOwnerBookingAlertSettings, OwnerBookingAlertError } from '@/lib/owner-booking-alerts/services.server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' };
function failure(error: unknown) {
  const known = error instanceof OwnerBookingAlertError;
  const code = known ? error.code : 'unavailable';
  const messages: Record<string, string> = {
    invalid: 'Check the mobile number and consent checkbox.',
    conflict: 'These settings changed. Refresh and try again.',
    forbidden: 'Booking alerts are unavailable for this account.',
    unavailable: 'Booking alerts are temporarily unavailable. Please try again later.',
    phone_not_mobile: 'Enter a US mobile number that can receive texts.',
    phone_reserved: 'Use your own mobile number, not a SimplAssist assistant number.',
    rate_limited: 'Please wait before requesting another verification text.',
  };
  return NextResponse.json({ error: messages[code] ?? messages.unavailable, code }, { status: known ? error.status : 503, headers });
}
export async function GET() {
  const access = await requireFreshWorkspaceRouteAccess();
  if (!access.ok) return access.response;
  try { return NextResponse.json({ alerts: await getOwnerBookingAlertSettings(access.access.business.id) }, { headers }); }
  catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  const access = await requireFreshWorkspaceRouteAccess();
  if (!access.ok) return access.response;
  const raw = await readBoundedJsonBody(request, 4096);
  let input: unknown;
  try { input = raw === null ? null : JSON.parse(raw); }
  catch { input = null; }
  const parsed = ownerBookingAlertMutationSchema.safeParse(input);
  if (!parsed.success) return failure(new OwnerBookingAlertError('invalid'));
  try {
    const alerts = await mutateOwnerBookingAlertSettings(access.access.business.id, access.access.user.id, parsed.data);
    return NextResponse.json({ alerts }, { headers });
  } catch (error) { return failure(error); }
}
