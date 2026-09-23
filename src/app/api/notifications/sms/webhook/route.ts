import { NextRequest, NextResponse } from 'next/server';
import { readBoundedJsonBody } from '@/lib/http/boundedBody.server';
import { handleOwnerBookingAlertWebhook } from '@/lib/owner-booking-alerts/webhook.server';
import { OwnerBookingAlertError } from '@/lib/owner-booking-alerts/services.server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
export async function POST(request: NextRequest) {
  const attempts = request.nextUrl.searchParams.getAll('attempt');
  if (attempts.length > 1 || (attempts.length === 1 && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempts[0]))) {
    return NextResponse.json({ error: 'Invalid callback reference' }, { status: 400, headers });
  }
  const raw = await readBoundedJsonBody(request, 65536);
  if (raw === null) return NextResponse.json({ error: 'Invalid payload' }, { status: 400, headers });
  try {
    const result = await handleOwnerBookingAlertWebhook(raw, Object.fromEntries(request.headers.entries()), attempts[0]);
    return NextResponse.json({ received: true, ...result }, { headers });
  } catch (error) {
    const status = error instanceof OwnerBookingAlertError ? error.status : 503;
    return NextResponse.json({ error: status >= 500 ? 'Please retry delivery' : 'Invalid webhook' }, { status, headers });
  }
}
