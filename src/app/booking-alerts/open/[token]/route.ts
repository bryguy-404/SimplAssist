import { NextRequest, NextResponse } from 'next/server';
import { BookingAlertLinkError, resolveBookingAlertLink } from '@/lib/owner-booking-alerts/links.server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  try {
    const target = await resolveBookingAlertLink(params.token);
    return new NextResponse(null, { status: 303, headers: { ...headers, Location: target } });
  } catch (error) {
    const status = error instanceof BookingAlertLinkError ? error.status : 503;
    return new NextResponse(status === 404 ? 'This booking alert link is no longer available. Open your usual SimplAssist dashboard.' : 'Please try this link again shortly.', { status, headers });
  }
}

// Carrier previews never consume a navigation token.
export const HEAD = GET;
