import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runOwnerBookingAlerts } from '@/lib/owner-booking-alerts/services.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest) {
  const secret = process.env.OWNER_BOOKING_ALERTS_INTERNAL_TOKEN ?? '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  if (secret.length < 32 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return new NextResponse('Not found', { status: 404, headers });
  }
  try {
    const counts = await runOwnerBookingAlerts();
    return NextResponse.json({ ok: true, ...counts }, { headers });
  } catch {
    return NextResponse.json({ error: 'Booking alert maintenance needs retry.' }, { status: 503, headers });
  }
}
