import { NextRequest, NextResponse } from 'next/server';
import { requireFreshWorkspaceRouteAccess } from '@/lib/customer/workspaceRouteResponse.server';
import { loadBookingReview } from '@/lib/booking/review.server';
export const dynamic = 'force-dynamic';
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const workspace = await requireFreshWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;
  const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie' };
  try {
    const bookings = await loadBookingReview(workspace.access.business.id,params.id);
    return bookings === null ? NextResponse.json({error:'Conversation not found'},{status:404,headers}) : NextResponse.json({conversationId:params.id,bookings},{headers});
  } catch { return NextResponse.json({error:'Booking review is temporarily unavailable'},{status:503,headers}); }
}
