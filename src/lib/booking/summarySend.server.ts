import 'server-only';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { recordOutboundSmsUsage } from '@/lib/billing/usage';
export interface BookingSummarySend {
  draft_id: string; business_id: string; revision: number; content: string;
  status: 'submitting' | 'accepted' | 'uncertain' | 'failed';
  provider_message_id: string | null; accepted_at: string | null; usage_recorded_at: string | null;
}
export async function claimBookingSummarySend(args: { businessId: string; draftId: string; revision: number; sender: string; destination: string; content: string }) {
  const r = await db.rpc('claim_booking_summary_send', { p_business_id: args.businessId, p_draft_id: args.draftId, p_revision: args.revision, p_sender: args.sender, p_destination: args.destination, p_content: args.content });
  if (r.error || !r.data) throw new Error('booking_summary_not_claimed');
  return r.data as { send: boolean; record: BookingSummarySend };
}
export async function recordBookingSummaryAcceptance(record: BookingSummarySend, providerId: string, acceptedAt: string) {
  const result = await db.from('booking_summary_sends').update({ status: 'accepted', provider_message_id: providerId, accepted_at: acceptedAt }).eq('draft_id', record.draft_id).eq('business_id', record.business_id).eq('status', 'submitting');
  if (result.error) throw new Error('booking_summary_acceptance_not_saved');
  return { ...record, status: 'accepted' as const, provider_message_id: providerId, accepted_at: acceptedAt };
}
export async function markBookingSummaryUncertain(record: BookingSummarySend) {
  const result = await db.from('booking_summary_sends').update({ status: 'uncertain' }).eq('draft_id', record.draft_id).eq('business_id', record.business_id).eq('status','submitting');
  if (result.error) throw new Error('booking_summary_uncertainty_not_saved');
}
export async function finalizeBookingSummarySend(record: BookingSummarySend) {
  if (record.status !== 'accepted' || !record.provider_message_id || !record.accepted_at) throw new Error('booking_summary_acceptance_missing');
  const result = await db.rpc('finalize_booking_summary_send', { p_draft_id: record.draft_id });
  if (result.error || !result.data) throw new Error('booking_summary_bookkeeping_failed');
  if (!record.usage_recorded_at) {
    await recordOutboundSmsUsage({ businessId: record.business_id, text: record.content, source: 'ai_reply', providerMessageId: record.provider_message_id, idempotencyKey: `booking-summary:${record.draft_id}` });
    const saved = await db.from('booking_summary_sends').update({ usage_recorded_at: new Date().toISOString() }).eq('draft_id', record.draft_id).eq('business_id', record.business_id).is('usage_recorded_at',null);
    if (saved.error) throw new Error('booking_summary_usage_failed');
  }
  return result.data as { id: string };
}
export async function reconcileBookingSummarySends() {
  const rows = await db.from('booking_summary_sends').select('*').eq('status','accepted').is('usage_recorded_at',null).order('reconciled_at',{ nullsFirst: true }).limit(12);
  if (rows.error) throw new Error('booking_summary_recovery_unavailable');
  for (const row of rows.data ?? []) {
    try { await finalizeBookingSummarySend(row as BookingSummarySend); }
    finally { await db.from('booking_summary_sends').update({ reconciled_at: new Date().toISOString() }).eq('draft_id',row.draft_id).eq('business_id',row.business_id); }
  }
}
