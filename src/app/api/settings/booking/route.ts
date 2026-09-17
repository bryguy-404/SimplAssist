import { NextRequest, NextResponse } from 'next/server';
import { requireFreshWorkspaceRouteAccess } from '@/lib/customer/workspaceRouteResponse.server';
import { bookingSettingsUpdateSchema } from '@/lib/booking/contracts';
import { getBookingSettings, updateBookingSettings, BookingSettingsError } from '@/lib/booking/settings.server';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' };
function failure(error: unknown) {
  const code = error instanceof BookingSettingsError ? error.code : 'unavailable';
  return NextResponse.json({ error: code === 'conflict' ? 'Booking settings changed. Refresh before saving again.' : code === 'forbidden' ? 'Booking settings are unavailable for this account.' : 'Booking settings could not be loaded. Please try again.' }, { status: code === 'conflict' ? 409 : code === 'forbidden' ? 403 : 503, headers });
}
export async function GET() {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  try { return NextResponse.json({ booking: await getBookingSettings(workspace.access.business.id) }, { headers }); }
  catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers }); }
  const parsed = bookingSettingsUpdateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Check the appointment format, duration and address.' }, { status: 400, headers });
  try { return NextResponse.json({ booking: await updateBookingSettings(workspace.access.business.id, workspace.access.user.id, parsed.data) }, { headers }); }
  catch (error) { return failure(error); }
}
