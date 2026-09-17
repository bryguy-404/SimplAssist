import 'server-only';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { telnyx } from '@/lib/messaging/client';
import { getOutboundSendContext } from '@/lib/messaging/lookup';
import { preflightOutboundSms, recordOutboundSmsUsage } from '@/lib/billing/usage';
import { resolveOutboundSmsOperationalAccess } from '@/lib/messaging/outboundSmsOperational.server';
import type { BookingSnapshot } from './contracts';
import type { VoiceAction } from '@/lib/voice/actions';
import { bookingDraftSummary } from './draft';

interface NotificationRow {
  id: string; business_id: string; draft_id: string; draft_revision: number;
  purpose: 'review' | 'confirmation'; permission_action_id: string; destination: string; content: string;
  status: 'authorized' | 'submitting' | 'accepted' | 'delivered' | 'failed' | 'uncertain' | 'cancelled';
  provider_message_id: string | null; accepted_at: string | null; usage_recorded_at: string | null;
}
export async function getBookingNotificationDraft(businessId: string, conversationId: string, draftId: string, revision: number, purpose: 'review' | 'confirmation') {
  const result = await db.from('booking_drafts').select('id,revision,status,snapshot').eq('business_id', businessId).eq('conversation_id', conversationId).order('revision', { ascending: false }).limit(1).maybeSingle();
  const d = result.data;
  if (result.error || !d || d.id !== draftId || d.revision !== revision || !(purpose === 'review' ? ['preparing','awaiting_confirmation'] : ['confirmed','requested']).includes(d.status)) throw new Error('booking_text_draft_not_current');
  return d as { id: string; revision: number; status: string; snapshot: BookingSnapshot };
}
export function bookingNotificationBody(name: string, snapshot: BookingSnapshot, purpose: 'review' | 'confirmation') {
  const review = bookingDraftSummary(snapshot);
  const details = review.replace(/^May I book /, '').replace(/^May I save a request for /, '').replace(/ Is all of that correct\?$/, '').replace('minutes?', 'minutes.');
  return `${name}: ${purpose === 'review' ? 'Please review: ' : snapshot.mode === 'schedule_direct' ? 'Appointment confirmed: ' : 'Request received for business review: '}${details}${purpose === 'review' ? ' Tell the assistant on the call if anything needs correcting. Nothing is booked yet.' : ''}\nReply STOP to opt out.`;
}
export async function finalizeBookingNotification(n: NotificationRow) {
  if (!n.provider_message_id || !n.accepted_at) throw new Error('booking_text_acceptance_missing');
  const saved = await db.rpc('finalize_booking_notification', { p_notification_id: n.id });
  if (saved.error || !saved.data) throw new Error('booking_text_bookkeeping_failed');
  if (!n.usage_recorded_at) {
    await recordOutboundSmsUsage({ businessId: n.business_id, text: n.content, source: 'voice_followup_sms', providerMessageId: n.provider_message_id, idempotencyKey: `booking-notification:${n.id}` });
    const update = await db.from('booking_notifications').update({ usage_recorded_at: new Date().toISOString() }).eq('id', n.id).eq('business_id', n.business_id).is('usage_recorded_at', null);
    if (update.error) throw new Error('booking_text_usage_failed');
  }
}
function notificationSummary(n: NotificationRow) {
  if (n.status === 'delivered') return 'The booking text was delivered. Continue naturally, offering help or listening for any questions.';
  if (n.status === 'failed' || n.status === 'cancelled') return 'The booking text could not be sent or delivered. Continue helping on the call. This does not cancel an already confirmed appointment or saved request.';
  if (n.provider_message_id) return 'The booking text was accepted for sending, but delivery is not yet confirmed. Ask the caller to let you know when it arrives, then continue naturally. A review text is not a booking confirmation.';
  return 'The text result is still being checked. Do not send another copy or claim delivery. Continue helping on the call.';
}
export async function sendBookingNotification(action: VoiceAction, call: { caller_phone: string; called_phone: string; action_conversation_id?: string | null; conversation_id: string | null }, businessName: string) {
  if (action.payload.kind !== 'booking_review_text' && action.payload.kind !== 'booking_confirmation_text') throw new Error('booking_text_kind_invalid');
  const purpose = action.payload.kind === 'booking_review_text' ? 'review' : 'confirmation';
  const d = await getBookingNotificationDraft(action.business_id, (call.action_conversation_id || call.conversation_id)!, action.payload.draftId, action.payload.revision, purpose);
  const content = bookingNotificationBody(businessName, d.snapshot, purpose);
  if (content.length > 1600) throw new Error('booking_text_too_long');
  const authorized = await db.rpc('authorize_booking_notification', { p_action_id: action.id, p_content: content });
  if (authorized.error || !authorized.data) throw new Error('booking_text_not_authorized');
  let n = authorized.data as NotificationRow;
  if (n.status !== 'authorized') return { summary: notificationSummary(n), notificationId: n.id, deliveryStatus: n.status };
  let submitting = false;
  try {
    const send = await getOutboundSendContext(call.called_phone);
    if (!send.smsReady || send.businessId !== action.business_id || !send.messagingProfileId || n.destination !== call.caller_phone) throw new Error('booking_text_route_unavailable');
    let inspected = 0;
    for await (const optout of telnyx.messagingOptouts.list({ filter: { messaging_profile_id: send.messagingProfileId }, redaction_enabled: 'false' }, { maxRetries: 0, timeout: 5000 })) {
      if (++inspected > 10000 || optout.to === n.destination) throw new Error('booking_text_optout');
    }
    const preflight = await preflightOutboundSms({ businessId: action.business_id, text: n.content, purpose: 'voice_followup' });
    const operational = await resolveOutboundSmsOperationalAccess(action.business_id, 'voice_followup');
    if (!preflight.allowed || !operational.allowed) throw new Error('booking_text_blocked');
    if (purpose === 'review') {
      const current = await db.rpc('voice_action_execution_current', { p_action_id: action.id });
      if (current.error || !current.data) throw new Error('booking_review_call_ended');
      await getBookingNotificationDraft(action.business_id, (call.action_conversation_id || call.conversation_id)!, d.id, d.revision, purpose);
    }
    const claim = await db.from('booking_notifications').update({ status: 'submitting', updated_at: new Date().toISOString() }).eq('id', n.id).eq('business_id', n.business_id).eq('status', 'authorized').select('id');
    if (claim.error) throw new Error('booking_text_claim_failed');
    if (!claim.data?.length) return { summary: 'The text was already submitted. Do not send another copy.', notificationId: n.id };
    submitting = true;
    const response = await telnyx.messages.send({ from: call.called_phone, to: n.destination, text: n.content, messaging_profile_id: send.messagingProfileId, type: 'SMS' }, { maxRetries: 0, timeout: 10000 });
    if (!response.data?.id) throw new Error('booking_text_acceptance_unknown');
    n = { ...n, status: 'accepted', provider_message_id: response.data.id, accepted_at: new Date().toISOString() };
    const accepted = await db.from('booking_notifications').update({ status: n.status, provider_message_id: n.provider_message_id, accepted_at: n.accepted_at, updated_at: n.accepted_at }).eq('id', n.id).eq('business_id', n.business_id).eq('status', 'submitting');
    if (accepted.error) throw new Error('booking_text_acceptance_save_failed');
    // Once provider acceptance is stored, bookkeeping failures cannot reverse it.
    try { await finalizeBookingNotification(n); } catch { /* durable reconciliation handles bookkeeping */ }
    return { summary: notificationSummary(n), notificationId: n.id, deliveryStatus: n.status };
  } catch {
    const status = submitting ? 'uncertain' : 'failed';
    await db.from('booking_notifications').update({ status, updated_at: new Date().toISOString() }).eq('id', n.id).eq('business_id', n.business_id).eq('status', submitting ? 'submitting' : 'authorized');
    return { summary: notificationSummary({ ...n, status }), notificationId: n.id, deliveryStatus: status };
  }
}
export async function reconcileBookingNotifications() {
  const pending = await db.from('booking_notifications').select('*').or('and(provider_message_id.not.is.null,usage_recorded_at.is.null),status.eq.accepted,status.eq.submitting').order('reconciled_at', { nullsFirst: true }).limit(12);
  if (pending.error) throw new Error('booking_text_recovery_unavailable');
  for (const raw of pending.data ?? []) {
    const n = raw as NotificationRow;
    try {
      if (n.provider_message_id && n.accepted_at) {
        await finalizeBookingNotification(n);
        const response = await telnyx.messages.retrieve(n.provider_message_id, { maxRetries: 0, timeout: 5000 });
        const permission = await db.from('voice_actions').select('session_id').eq('id',n.permission_action_id).eq('business_id',n.business_id).single();
        if (permission.error || !permission.data) throw new Error('booking_text_source_missing');
        const session = await db.from('voice_sessions').select('called_phone').eq('id',permission.data.session_id).eq('business_id',n.business_id).single();
        if (session.error || !session.data || response.data?.from?.phone_number !== session.data.called_phone) throw new Error('booking_text_provider_mismatch');
        const recipient = response.data?.to?.[0];
        if (recipient?.phone_number !== n.destination) throw new Error('booking_text_provider_mismatch');
        const status = recipient.status === 'delivered' ? 'delivered' : ['delivery_failed','sending_failed','expired','cancelled'].includes(recipient.status ?? '') ? 'failed' : n.status;
        const updated = await db.from('booking_notifications').update({ status }).eq('id', n.id).eq('business_id', n.business_id);
        if (updated.error) throw new Error('booking_text_delivery_save_failed');
        const action = await db.from('voice_actions').update({ status: status === 'failed' ? 'failed' : 'succeeded', recovery_complete: true, result: { summary: notificationSummary({ ...n, status }), notificationId: n.id, deliveryStatus: status }, updated_at: new Date().toISOString() }).eq('id', n.permission_action_id).eq('business_id', n.business_id).in('status',['executing','uncertain','succeeded']);
        if (action.error) throw new Error('booking_text_action_recovery_failed');
      } else if (n.status === 'submitting' && Date.parse(raw.updated_at) < Date.now()-60000) {
        await db.from('booking_notifications').update({ status: 'uncertain' }).eq('id', n.id).eq('status', 'submitting');
      }
    } finally {
      await db.from('booking_notifications').update({ reconciled_at: new Date().toISOString() }).eq('id', n.id).eq('business_id', n.business_id);
    }
  }
}
