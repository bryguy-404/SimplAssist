import 'server-only';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import type { BookingReview } from './review';
/** Fresh workspace authorization is required before calling this projection. */
export async function loadBookingReview(businessId: string, conversationId: string): Promise<BookingReview[] | null> {
  const conversation = await db.from('conversations').select('id').eq('business_id',businessId).eq('id',conversationId).maybeSingle();
  if (conversation.error) throw new Error('booking_review_unavailable');
  if (!conversation.data) return null;
  const drafts = await db.from('booking_drafts').select('id,revision,status,created_at,snapshot').eq('business_id',businessId).eq('conversation_id',conversationId).order('revision',{ascending:false}).limit(100);
  if (drafts.error) throw new Error('booking_review_unavailable');
  if (!drafts.data?.length) return [];
  const notices = await db.from('booking_notifications').select('id,draft_id,purpose,status,accepted_at,outbound_message_id').eq('business_id',businessId).in('draft_id',drafts.data.map(d=>d.id));
  if (notices.error) throw new Error('booking_review_unavailable');
  const ids = (notices.data ?? []).flatMap(n=>n.outbound_message_id ? [n.outbound_message_id] : []);
  const messages = ids.length ? await db.from('messages').select('id,conversation_id').eq('business_id',businessId).eq('channel','sms').eq('role','assistant').in('id',ids) : { data: [], error: null };
  if (messages.error) throw new Error('booking_review_unavailable');
  return drafts.data.map(d=>({ id:d.id, revision:d.revision, status:d.status, createdAt:d.created_at, snapshot:d.snapshot,
    notifications:(notices.data??[]).filter(n=>n.draft_id===d.id).map(n=>({id:n.id,purpose:n.purpose,status:n.status,acceptedAt:n.accepted_at,conversationId:messages.data?.find(m=>m.id===n.outbound_message_id)?.conversation_id??null}))
  }));
}
