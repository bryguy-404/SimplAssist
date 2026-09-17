import 'server-only';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { getEffectiveBookingOffering } from './settings.server';
import { canUseFeature, resolveBusinessEntitlements } from '@/lib/billing/entitlements';
import { assertBookingOperationallyAllowed } from '@/lib/google/bookingOperational.server';
import type { BookingDraft, BookingSnapshot } from './contracts';
export class BookingDraftNotAuthorizedError extends Error {}
export interface BookingDraftAuthority { draftId: string; revision: number }
export async function validateBookingDraftAuthority(businessId: string, authority: BookingDraftAuthority, linkage: { contactId: string; conversationId: string; sourceMessageId: string }, params: { customerName: string; customerPhone?: string; customerEmail?: string; serviceName: string; startTime: string }) : Promise<BookingSnapshot> {
  const result = await db.from('booking_drafts').select('*').eq('business_id', businessId).eq('id', authority.draftId).maybeSingle();
  const draft = result.data as BookingDraft & { contact_id: string } | null;
  if (result.error || !draft || draft.revision !== authority.revision || draft.status !== 'submitted' || draft.contact_id !== linkage.contactId || draft.conversation_id !== linkage.conversationId || draft.confirmation_message_id !== linkage.sourceMessageId) throw new BookingDraftNotAuthorizedError('booking_draft_not_authorized');
  await assertBookingOperationallyAllowed(businessId);
  if (!canUseFeature(await resolveBusinessEntitlements(businessId), 'direct_booking')) throw new BookingDraftNotAuthorizedError('booking_not_entitled');
  const [business, config, control, message] = await Promise.all([
    db.from('businesses').select('owner_id,deleted_at,primary_goal').eq('id', businessId).single(),
    db.from('ai_settings').select('booking_enabled,booking_mode').eq('business_id', businessId).single(),
    db.from('booking_confirmation_control').select('enabled').eq('singleton', true).single(),
    db.from('messages').select('created_at').eq('id', linkage.sourceMessageId).eq('business_id', businessId).eq('conversation_id', linkage.conversationId).single(),
  ]);
  if (business.error || config.error || control.error || message.error || !business.data?.owner_id || business.data.deleted_at !== null || business.data.primary_goal !== 'book' || !config.data?.booking_enabled || config.data.booking_mode !== 'schedule_direct' || !control.data?.enabled || !message.data) throw new BookingDraftNotAuthorizedError('booking_no_longer_available');
  const newer = await db.from('messages').select('id').eq('business_id', businessId).eq('conversation_id', linkage.conversationId).eq('role', 'customer').gt('created_at', message.data.created_at).limit(1);
  if (newer.error || newer.data?.length) throw new BookingDraftNotAuthorizedError('booking_confirmation_superseded');
  const s = draft.snapshot;
  if (s.mode !== 'schedule_direct' || s.name !== params.customerName || (s.phone ?? undefined) !== params.customerPhone || (s.email ?? undefined) !== params.customerEmail || s.offering.serviceName !== params.serviceName || s.startTime !== params.startTime) throw new BookingDraftNotAuthorizedError('booking_snapshot_mismatch');
  const current = await getEffectiveBookingOffering(businessId, s.offering.serviceId);
  if (!current || Object.keys(current).some(key => current[key as keyof typeof current] !== s.offering[key as keyof typeof current])) throw new BookingDraftNotAuthorizedError('booking_offering_changed');
  return s;
}
