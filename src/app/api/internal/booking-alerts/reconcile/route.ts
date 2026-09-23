import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { reconcilePendingCalendarBookings } from '@/lib/google/bookingReconciler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'no-store' };

/** Google recovery has its own time budget, separate from sending the SMS queue. */
export async function POST(request: NextRequest) {
  const secret = process.env.OWNER_BOOKING_ALERTS_INTERNAL_TOKEN ?? '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  if (secret.length < 32 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return new NextResponse('Not found', { status: 404, headers });
  }
  try {
    if (process.env.OWNER_BOOKING_ALERTS_ENABLED === 'true' &&
        process.env.OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED === 'true') {
      // This bounds admission of another row, not an in-flight Google request.
      // The existing provider timeout/claim fencing handles that request.
      await reconcilePendingCalendarBookings({ deadlineAt: Date.now() + 5000 });
    }
    return NextResponse.json({ ok: true }, { headers });
  } catch {
    return NextResponse.json({ error: 'Booking confirmation recovery needs retry.' }, { status: 503, headers });
  }
}
