import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { actionReviewStatus, confirmedCallContact, type CallContact, type ConfirmedCallContact, type ReviewActionRow, type ReviewStatus } from "./callReview";

export interface VoiceLeadSource {
  id: string;
  origin_kind: string;
  voice_action_id: string | null;
  source_conversation_id: string | null;
  contact_id: string | null;
  contact: { name: string | null; phone_number: string | null; email: string | null } | null;
}
export interface VoiceLeadReview {
  confirmedContact: ConfirmedCallContact | null;
  status: ReviewStatus;
  sourceConversationId: string;
}

/** Owner-client reads preserve RLS; action and call scope are checked again before display. */
export async function loadVoiceLeadReviews(db: SupabaseClient, businessId: string, events: VoiceLeadSource[]): Promise<Map<string, VoiceLeadReview>> {
  const reviews = new Map<string, VoiceLeadReview>();
  const voiceEvents = events.filter((event) => event.origin_kind === "voice_action" && event.voice_action_id && event.source_conversation_id);
  if (!voiceEvents.length) return reviews;
  const signup = await db.from("voice_actions")
    .select("id,business_id,session_id,kind,status,payload,result,confirmed_at,created_at,revision")
    .eq("business_id", businessId).eq("kind", "signup").eq("status", "succeeded")
    .in("id", voiceEvents.map((event) => event.voice_action_id!));
  if (signup.error) throw new Error("voice_lead_review_unavailable");
  const signupActions = (signup.data || []) as ReviewActionRow[];
  const ids = Array.from(new Set(signupActions.map((action) => action.session_id)));
  if (!ids.length) return reviews;
  const [sessions, contactActions] = await Promise.all([
    db.from("voice_sessions").select("id,business_id,conversation_id,caller_phone")
      .eq("business_id", businessId).in("id", ids),
    db.from("voice_actions").select("id,business_id,session_id,kind,status,payload,result,confirmed_at,created_at,revision")
      .eq("business_id", businessId).in("session_id", ids).eq("status", "succeeded")
      .in("kind", ["contact", "booking", "booking_request"]).order("revision", { ascending: false }).limit(1000),
  ]);
  if (sessions.error || contactActions.error) throw new Error("voice_lead_review_unavailable");
  for (const event of voiceEvents) {
    const action = signupActions.find((row) => row.id === event.voice_action_id && row.business_id === businessId && row.kind === "signup" && row.status === "succeeded" && row.confirmed_at);
    const session = action && (sessions.data || []).find((row) => row.id === action.session_id && row.business_id === businessId && row.conversation_id === event.source_conversation_id);
    if (!action || !session) continue;
    const contact: CallContact | null = event.contact && event.contact_id ? {
      id: event.contact_id, name: event.contact.name, phone: event.contact.phone_number, email: event.contact.email,
    } : null;
    reviews.set(event.id, {
      confirmedContact: confirmedCallContact((contactActions.data || []) as ReviewActionRow[], businessId, session.id, session.caller_phone, contact, action.revision),
      status: actionReviewStatus(action, true), sourceConversationId: session.conversation_id,
    });
  }
  return reviews;
}
