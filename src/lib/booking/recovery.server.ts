import 'server-only';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
/** Read durable results only. A timeout is never permission to repeat a provider mutation. */
export async function reconcileBookingDrafts() {
  const pending = await db.from('booking_drafts').select('id,business_id,confirmation_message_id,status,snapshot').in('status', ['submitted','uncertain']).lt('updated_at', new Date(Date.now()-60000).toISOString()).order('reconciled_at', { nullsFirst: true }).limit(16);
  if (pending.error) throw new Error('booking_reconciliation_unavailable');
  for (const draft of pending.data ?? []) {
    if (!draft.confirmation_message_id) continue;
    const direct = draft.snapshot.mode === 'schedule_direct';
    const result = await db.from(direct ? 'calendar_bookings' : 'booking_requests').select(direct ? 'id,status,google_event_id,starts_at,ends_at' : 'id,status').eq('business_id', draft.business_id).eq('source_message_id', draft.confirmation_message_id).maybeSingle();
    if (result.error) continue;
    const row = result.data as { id: string; status: string; google_event_id?: string; starts_at?: string; ends_at?: string } | null;
    let status = draft.status;
    let outcome: Record<string, unknown> | undefined;
    if (row && (!direct || row.status === 'confirmed')) {
      status = direct ? 'confirmed' : 'requested';
      outcome = { status, bookingId: row.id, eventId: row.google_event_id, startTime: row.starts_at, endTime: row.ends_at, summary: direct ? 'The appointment is confirmed in the calendar.' : 'The request was saved for the business to review. It is not a confirmed appointment.' };
    } else if (direct && row && ['failed','cancelled'].includes(row.status)) {
      status = 'failed'; outcome = { status, summary: 'The calendar did not confirm this appointment.' };
    }
    const updated = await db.from('booking_drafts').update({ status, ...(outcome ? { result: outcome } : {}), reconciled_at: new Date().toISOString() }).eq('id', draft.id).eq('business_id', draft.business_id).eq('status', draft.status);
    if (updated.error) throw new Error('booking_reconciliation_save_failed');
  }
}
