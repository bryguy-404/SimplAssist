import type { BookingSnapshot, BookingDraft } from './contracts';
export interface BookingReview {
  id: string; revision: number; status: BookingDraft['status']; createdAt: string;
  snapshot: BookingSnapshot;
  notifications: Array<{ id: string; purpose: 'review' | 'confirmation'; status: string; acceptedAt: string | null; conversationId: string | null }>;
}
export function bookingStatusLabel(status: string): string {
  return ({ preparing: 'Details being collected', awaiting_confirmation: 'Awaiting confirmation', submitted: 'Checking booking result', confirmed: 'Appointment confirmed', requested: 'Request saved for business review', uncertain: 'Result needs review — do not repeat', failed: 'Appointment not confirmed', abandoned: 'Not confirmed before the call ended', superseded: 'Replaced by updated details' } as Record<string,string>)[status] ?? 'Result unavailable';
}
export function bookingTextStatus(status: string): string {
  return ({ authorized: 'Permission received', submitting: 'Sending — result pending', accepted: 'Text sent; delivery pending', delivered: 'Text delivered', failed: 'Text could not be sent or delivered', uncertain: 'Text result needs review', cancelled: 'Text not sent' } as Record<string,string>)[status] ?? 'Text status unavailable';
}
