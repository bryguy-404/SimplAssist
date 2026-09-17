import 'server-only';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { canUseFeature, resolveBusinessEntitlements } from '@/lib/billing/entitlements';
import { assertBookingOperationallyAllowed } from '@/lib/google/bookingOperational.server';
import { getBookingSettings } from './settings.server';
import { resolveBookingOffering, type BookingDraft, type BookingSnapshot } from './contracts';
import { prepareBookingInput, bookingDraftSummary, bookingDraftMissingFields } from './draft';
import { BookingDraftNotAuthorizedError } from './authorization.server';
import { VoiceBookingNotSubmittedError } from '@/lib/voice/bookingAccess.server';
import { createBooking, BookingSlotUnavailableError } from '@/lib/google/calendar';
import { recordBookingRequest } from '@/lib/ai/bookingRequests';
import type { VoiceBookingAuthority } from '@/lib/voice/bookingAccess.server';

export class BookingInputError extends Error {}
export async function buildBookingDraft(args: { businessId: string; conversationId: string; contactId: string; sourceMessageId: string | null; voiceActionId?: string; input: unknown; readback?: string }) {
  const input = prepareBookingInput.parse(args.input);
  await assertBookingOperationallyAllowed(args.businessId);
  if (!canUseFeature(await resolveBusinessEntitlements(args.businessId), 'direct_booking')) throw new Error('booking_not_entitled');
  const [business, ai, settings, service] = await Promise.all([
    db.from('businesses').select('primary_goal,timezone').eq('id', args.businessId).single(),
    db.from('ai_settings').select('booking_enabled,booking_mode').eq('business_id', args.businessId).single(),
    getBookingSettings(args.businessId),
    input.serviceId ? db.from('services').select('id,name,is_active').eq('business_id', args.businessId).eq('id', input.serviceId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (business.error || ai.error || service.error || !business.data || !ai.data || business.data.primary_goal !== 'book' || !ai.data.booking_enabled) throw new Error('booking_unavailable');
  const mode = ai.data.booking_mode;
  if (mode !== 'collect_info' && mode !== 'schedule_direct') throw new Error('booking_mode_invalid');
  const catalogService = service.data;
  if (input.serviceId && (!catalogService || !catalogService.is_active)) throw new Error('booking_service_unavailable');
  if (mode === 'schedule_direct' && !catalogService) throw new BookingInputError('Ask which service the customer wants to book.');
  const offering = catalogService
    ? resolveBookingOffering(mode === 'collect_info' ? { ...settings, services: settings.services.filter(s => s.serviceId !== catalogService.id || s.setting.mode !== 'unavailable') } : settings, catalogService)
    : { serviceId: '', serviceName: input.requestedService ?? 'not specified', settingsRevision: settings.revision, format: settings.defaults?.format ?? 'unspecified' as const, label: settings.defaults?.label ?? 'Appointment', durationMinutes: settings.defaults?.durationMinutes ?? 30, businessAddress: settings.defaults?.businessAddress ?? null, requiresCustomerAddress: settings.defaults?.format === 'customer_site' };
  if (!offering) throw new BookingInputError('This service is not available for direct booking. Offer owner assistance without promising an appointment.');
  const snapshot: BookingSnapshot = { offering, name: input.name ?? '', phone: input.phone ?? null, email: input.email?.toLowerCase() ?? null, emailAsked: input.emailAsked, customerAddress: input.customerAddress ?? null, startTime: input.startTime ?? null, requestedTime: input.requestedTime ?? null, timezone: business.data.timezone, mode };
  const missing = bookingDraftMissingFields(snapshot);
  if (missing.length) throw new BookingInputError(`Still needed: ${missing.join(', ')}`);
  const summary = bookingDraftSummary(snapshot);
  if (args.readback && args.readback !== summary) throw new Error('booking_readback_changed');
  return { snapshot, summary, input };
}
export async function prepareBookingDraft(args: Parameters<typeof buildBookingDraft>[0]) {
  const { snapshot, summary, input } = await buildBookingDraft(args);
  const result = await db.rpc('prepare_booking_draft', { p_business_id: args.businessId, p_conversation_id: args.conversationId, p_contact_id: args.contactId, p_source_message_id: args.sourceMessageId, p_voice_action_id: args.voiceActionId ?? null, p_snapshot: snapshot, p_summary: summary, p_new_appointment: input.newAppointment ?? false });
  if (result.error || !result.data) throw new Error('booking_draft_prepare_failed');
  return result.data as BookingDraft & { summary_text: string; result: Record<string, unknown> | null };
}
export async function acknowledgeBookingSummary(args: { businessId: string; draftId: string; revision: number; messageId: string; providerMessageId?: string }) {
  const result = await db.rpc('acknowledge_booking_summary', { p_business_id: args.businessId, p_draft_id: args.draftId, p_revision: args.revision, p_message_id: args.messageId, p_provider_message_id: args.providerMessageId ?? null });
  if (result.error || !result.data) throw new Error('booking_summary_not_acknowledged');
}
export async function confirmBookingDraft(args: { businessId: string; draftId: string; revision: number; confirmationMessageId: string; voiceAuthority?: VoiceBookingAuthority }) {
  await assertBookingOperationallyAllowed(args.businessId);
  if (!canUseFeature(await resolveBusinessEntitlements(args.businessId), 'direct_booking')) throw new Error('booking_not_entitled');
  const claimed = await db.rpc('claim_booking_draft', { p_business_id: args.businessId, p_draft_id: args.draftId, p_revision: args.revision, p_confirmation_message_id: args.confirmationMessageId });
  if (claimed.error || !claimed.data) throw new Error('booking_confirmation_not_current');
  const draft = claimed.data.draft as BookingDraft & { contact_id: string; result: Record<string, unknown> | null };
  if (!claimed.data.execute) return draft.result ?? { summary: 'The existing appointment result is still being checked. Do not create another booking or claim success.', status: draft.status };
  const s = draft.snapshot;
  try {
    let result: Record<string, unknown>;
    let status: 'confirmed' | 'requested';
    if (s.mode === 'schedule_direct') {
      const booked = await createBooking(args.businessId, { customerName: s.name, customerPhone: s.phone ?? undefined, customerEmail: s.email ?? undefined, serviceName: s.offering.serviceName, startTime: s.startTime! }, s.timezone, { contactId: draft.contact_id, conversationId: draft.conversation_id, sourceMessageId: args.confirmationMessageId }, args.voiceAuthority, { draftId: draft.id, revision: draft.revision });
      result = { ...booked, summary: `Appointment confirmed: ${s.offering.label}, ${s.offering.serviceName}, ${s.startTime} (${s.timezone}).${s.email ? ' A calendar invitation was requested for the confirmed email.' : ''}`, status: 'confirmed' };
      status = 'confirmed';
    } else {
      await recordBookingRequest({ businessId: args.businessId, contactId: draft.contact_id, conversationId: draft.conversation_id, sourceMessageId: args.confirmationMessageId, requestedService: s.offering.serviceName, requestedTimeText: s.requestedTime ?? 'not specified', customerName: s.name || null, customerPhone: s.phone, customerEmail: s.email });
      result = { summary: 'Your appointment request has been saved for the business to review. It is not yet a confirmed appointment.', status: 'requested' }; status = 'requested';
    }
    const saved = await db.from('booking_drafts').update({ status, result, updated_at: new Date().toISOString() }).eq('business_id', args.businessId).eq('id', draft.id).eq('status', 'submitted');
    if (saved.error) throw new Error('booking_result_not_saved');
    return result;
  } catch (error) {
    const notSubmitted = error instanceof BookingDraftNotAuthorizedError || error instanceof BookingSlotUnavailableError || error instanceof VoiceBookingNotSubmittedError;
    await db.from('booking_drafts').update({ status: notSubmitted ? 'failed' : 'uncertain', updated_at: new Date().toISOString() }).eq('business_id', args.businessId).eq('id', draft.id).eq('status', 'submitted');
    if (notSubmitted) return { status: 'failed', summary: 'No appointment was booked. The details or availability changed. Review the current details and obtain a fresh confirmation.' };
    return { status: 'uncertain', summary: 'The booking result is still being checked. Do not say it failed or succeeded, and do not submit another appointment.' };
  }
}

export async function recoverBookingChatSummary(businessId: string, conversationId: string) {
  const result = await db.rpc('recover_booking_chat_summary', { p_business_id: businessId, p_conversation_id: conversationId });
  if (result.error) throw new Error('booking_chat_summary_recovery_failed');
}
