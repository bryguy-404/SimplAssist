import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  actionReviewStatus, actionReviewTitle, callReviewStatus, confirmedCallContact,
  reviewText, type CallContact, type ReviewActionRow, type VoiceCallReview,
} from "./callReview";

const ACTION_COLUMNS = "id,business_id,session_id,kind,status,payload,result,confirmed_at,created_at,revision,source_message_id";

/** Caller must first resolve fresh workspace access; every read is scoped again here. */
export async function loadVoiceCallReview(businessId: string, conversationId: string): Promise<VoiceCallReview | null> {
  const conversation = await supabaseAdmin.from("conversations")
    .select("id,contact_id").eq("id", conversationId).eq("business_id", businessId)
    .eq("channel", "voice").maybeSingle();
  if (conversation.error) throw new Error("voice_review_unavailable");
  if (!conversation.data) return null;
  const voiceConversation = conversation.data;
  const session = await supabaseAdmin.from("voice_sessions")
    .select("id,caller_phone,status,outcome,created_at,started_at,ended_at")
    .eq("business_id", businessId).eq("conversation_id", conversationId)
    .eq("response_mode", "voice").maybeSingle();
  if (session.error) throw new Error("voice_review_unavailable");
  if (!session.data) return null;
  const call = session.data;
  const [contactResult, actionsResult, recordingsResult, leadsResult] = await Promise.all([
    supabaseAdmin.from("contacts").select("id,name,phone_number,email")
      .eq("business_id", businessId).eq("id", voiceConversation.contact_id).maybeSingle(),
    supabaseAdmin.from("voice_actions").select(ACTION_COLUMNS)
      .eq("business_id", businessId).eq("session_id", call.id).order("revision"),
    supabaseAdmin.from("voice_recordings").select("recording_id,delete_after,deleted_at")
      .eq("business_id", businessId).eq("session_id", call.id).order("created_at"),
    supabaseAdmin.from("goal_events").select("id,voice_action_id,conversation_id,contact_id")
      .eq("business_id", businessId).eq("source_conversation_id", conversationId)
      .eq("origin_kind", "voice_action").eq("goal_at_event", "signup").eq("event_type", "link_sent"),
  ]);
  if ([contactResult, actionsResult, recordingsResult, leadsResult].some((r) => r.error)) throw new Error("voice_review_unavailable");
  const contactRow = contactResult.data;
  const contact: CallContact | null = contactRow ? {
    id: contactRow.id, name: reviewText(contactRow.name, 200),
    phone: reviewText(contactRow.phone_number, 32), email: reviewText(contactRow.email),
  } : null;
  const actions = (actionsResult.data || []) as ReviewActionRow[];
  const bookingStatus = new Map<string, string>();
  const bookingMessages = actions.filter((a) => a.kind === "booking" && a.source_message_id).map((a) => a.source_message_id!);
  if (bookingMessages.length) {
    const bookings = await supabaseAdmin.from("calendar_bookings").select("source_message_id,status,google_event_id")
      .eq("business_id", businessId).eq("conversation_id", conversationId).in("source_message_id", bookingMessages);
    if (bookings.error) throw new Error("voice_review_unavailable");
    for (const booking of bookings.data || []) bookingStatus.set(booking.source_message_id, booking.status === "confirmed" && !booking.google_event_id ? "pending" : booking.status);
  }
  const signupIds = actions.filter((a) => a.business_id === businessId && a.session_id === call.id && a.kind === "signup").map((a) => a.id);
  const smsByAction = new Map<string, string>();
  if (signupIds.length) {
    const messages = await supabaseAdmin.from("messages").select("id,conversation_id")
      .eq("business_id", businessId).eq("channel", "sms").eq("role", "assistant").in("id", signupIds);
    if (messages.error) throw new Error("voice_review_unavailable");
    const ids = Array.from(new Set((messages.data || []).map((message) => message.conversation_id)));
    if (ids.length) {
      const sms = await supabaseAdmin.from("conversations").select("id")
        .eq("business_id", businessId).eq("channel", "sms")
        .eq("contact_id", voiceConversation.contact_id).in("id", ids);
      if (sms.error) throw new Error("voice_review_unavailable");
      const allowed = new Set((sms.data || []).map((row) => row.id));
      for (const message of messages.data || []) if (allowed.has(message.conversation_id)) smsByAction.set(message.id, message.conversation_id);
    }
  }
  const elapsed = call.started_at && call.ended_at ? (Date.parse(call.ended_at) - Date.parse(call.started_at)) / 1000 : null;
  return {
    conversationId, receivedAt: call.created_at, startedAt: call.started_at, endedAt: call.ended_at,
    durationSeconds: elapsed !== null && Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null,
    call: callReviewStatus(call.status, call.outcome), contact,
    confirmedContact: confirmedCallContact(actions, businessId, call.id, call.caller_phone, contact),
    actions: actions.filter((a) => a.business_id === businessId && a.session_id === call.id).map((a) => {
      const smsConversationId = smsByAction.get(a.id) || null;
      const lead = (leadsResult.data || []).find((row) => row.voice_action_id === a.id && row.contact_id === voiceConversation.contact_id && row.conversation_id === smsConversationId);
      return { id: a.id, title: actionReviewTitle(a.kind), ...actionReviewStatus(a, call.status === "closed", bookingStatus.get(a.source_message_id || "")),
        confirmedAt: a.confirmed_at, smsConversationId, leadId: lead?.id || null };
    }),
    recordings: (recordingsResult.data || []).map((r) => {
      const expiresAt = Date.parse(r.delete_after);
      const state = !Number.isFinite(expiresAt) ? "unavailable" : r.deleted_at || expiresAt <= Date.now() ? "expired" : "available";
      return { id: r.recording_id, state, expiresAt: r.delete_after,
        url: state === "available" ? `/api/voice/recordings/${encodeURIComponent(r.recording_id)}` : null };
    }),
  };
}
