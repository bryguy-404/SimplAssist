import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
/** Optional authority is an identifier, never a caller-supplied entitlement flag. */
export interface VoiceBookingAuthority {
  sessionId: string;
  actionId?: string;
}
export async function validateVoiceBookingAccess(
  businessId: string,
  authority: VoiceBookingAuthority,
  sourceMessageId?: string,
): Promise<{ email?: string }> {
  const { data: allowed, error } = await supabaseAdmin.rpc(
    "voice_action_allowed",
    { p_session_id: authority.sessionId, p_kind: "booking" },
  );
  if (error || !allowed) throw new Error("voice_booking_not_authorized");
  const { data: s, error: se } = await supabaseAdmin
    .from("voice_sessions")
    .select("action_business_id,business_id,demo_mode,caller_phone")
    .eq("id", authority.sessionId)
    .single();
  if (se || !s || (s.action_business_id || s.business_id) !== businessId)
    throw new Error("voice_booking_scope_mismatch");
  if (s.demo_mode) {
    const [{ data: cfg, error: ce }, { data: token, error: te }] =
      await Promise.all([
        supabaseAdmin
          .from("voice_pilot_settings")
          .select("demo_business_id,demo_calendar_id")
          .eq("business_id", s.business_id)
          .single(),
        supabaseAdmin
          .from("google_calendar_tokens")
          .select("calendar_id")
          .eq("business_id", businessId)
          .single(),
      ]);
    if (
      ce ||
      te ||
      cfg?.demo_business_id !== businessId ||
      !cfg.demo_calendar_id ||
      token?.calendar_id !== cfg.demo_calendar_id
    )
      throw new Error("voice_demo_calendar_mismatch");
  }
  if (!sourceMessageId) return {};
  const { data: a, error: ae } = await supabaseAdmin
    .from("voice_actions")
    .select("payload,source_message_id,status,business_id,kind")
    .eq("id", authority.actionId || "00000000-0000-0000-0000-000000000000")
    .eq("session_id", authority.sessionId)
    .single();
  if (
    ae ||
    !a ||
    a.business_id !== businessId ||
    a.kind !== "booking" ||
    a.status !== "executing" ||
    a.source_message_id !== sourceMessageId
  )
    throw new Error("voice_booking_confirmation_missing");
  const current = await supabaseAdmin.rpc("voice_action_execution_current", {
    p_action_id: authority.actionId,
  });
  if (current.error || !current.data)
    throw new Error("voice_booking_confirmation_superseded");
  if (s.demo_mode && a.payload.email) {
    const { data: t, error: te } = await supabaseAdmin
      .from("voice_pilot_testers")
      .select("invitation_email")
      .eq("business_id", s.business_id)
      .eq("phone_number", s.caller_phone)
      .single();
    if (
      te ||
      !t?.invitation_email ||
      t.invitation_email.toLowerCase() !== a.payload.email.toLowerCase()
    )
      throw new Error("voice_demo_invitation_not_allowed");
  }
  return { email: a.payload.email };
}
