import { createHash, createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TranscriptFragment, VoiceSession } from "./types";

export const hashStreamToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function issueStreamToken(
  db: SupabaseClient,
  session: VoiceSession,
  secret: string,
): Promise<string> {
  if (secret.length < 32) throw new Error("voice_stream_secret_missing");
  // Deterministic per call makes Telnyx command retries reuse the same URL.
  // Only its digest is stored, and consumption cannot be reset by a retry.
  const token = createHmac("sha256", secret)
    .update(`voice-stream-v1:${session.id}`)
    .digest("base64url");
  const { error } = await db.from("voice_stream_credentials").upsert(
    {
      session_id: session.id,
      token_hash: hashStreamToken(token),
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    },
    { onConflict: "session_id", ignoreDuplicates: true },
  );
  if (error) throw new Error("voice_stream_credential_failed");
  return token;
}

export async function consumeStreamToken(
  db: SupabaseClient,
  token: string,
): Promise<VoiceSession | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { data, error } = await db.rpc("consume_voice_stream", {
    p_token_hash: hashStreamToken(token),
  });
  if (error) throw new Error("voice_stream_authorization_failed");
  if (data?.access_source === "commercial" &&
    (data.demo_mode || (data.action_business_id && data.action_business_id !== data.business_id)))
    throw new Error("voice_stream_identity_invalid");
  return data?.id ? (data as VoiceSession) : null;
}

export interface VoiceStore {
  activate(openaiId: string): Promise<void>;
  beginDisclosure?(openaiId: string): Promise<void>;
  completeDisclosure?(eventId: string): Promise<void>;
  recordingStarted?(): Promise<void>;
  activateNaturalOpening?(openaiId: string, inputStartMs: number): Promise<void>;
  handoffStarted?(eventId: string, startedAt: string): Promise<void>;
  handoffAcknowledged?(eventId: string, inputStartMs: number): Promise<void>;
  fragment(fragment: TranscriptFragment): Promise<void>;
  usage(seconds: number, confirmed: boolean): Promise<void>;
  heartbeat(): Promise<boolean>;
  audioSent(): Promise<void>;
  playbackAcknowledged(): Promise<void>;
  customerAudioStarted?(eventId: string, startedAt: string): Promise<void>;
  customerPlaybackAcknowledged?(eventId: string): Promise<void>;
  customerTermination?(eventId: string, terminatedAt: string): Promise<void>;
  finish(
    outcome: string,
    error: string | null,
    fallback: boolean,
  ): Promise<void>;
}

export function createVoiceStore(
  db: SupabaseClient,
  session: VoiceSession,
): VoiceStore {
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await db.rpc(name, {
      p_session_id: session.id,
      ...args,
    });
    if (error) throw new Error(`voice_store_${name}_failed`);
    return data;
  }
  async function timestamp(column: string) {
    const { error } = await db
      .from("voice_sessions")
      .update({ [column]: new Date().toISOString() })
      .eq("id", session.id)
      .is(column, null);
    if (error) throw new Error("voice_playback_tracking_failed");
  }
  return {
    async beginDisclosure(openaiId) {
      if (!(await rpc("begin_voice_disclosure", { p_openai_id: openaiId }))) throw new Error("voice_disclosure_blocked");
    },
    async completeDisclosure(eventId) {
      if (!(await rpc("complete_voice_disclosure", { p_event_id: eventId }))) throw new Error("voice_disclosure_blocked");
    },
    async recordingStarted() {
      if (!(await rpc("mark_voice_recording_started", {}))) throw new Error("voice_recording_start_blocked");
    },
    async activateNaturalOpening(openaiId, inputStartMs) {
      if (!(await rpc("activate_voice_natural_opening", { p_openai_id: openaiId, p_input_start_ms: inputStartMs }))) throw new Error("voice_natural_opening_blocked");
    },
    async handoffStarted(eventId, startedAt) {
      if (!(await rpc("begin_voice_conversation_handoff", { p_event_id: eventId, p_started_at: startedAt }))) throw new Error("voice_handoff_blocked");
    },
    async handoffAcknowledged(eventId, inputStartMs) {
      if (!(await rpc("acknowledge_voice_conversation_handoff", { p_event_id: eventId, p_input_start_ms: inputStartMs }))) throw new Error("voice_handoff_blocked");
    },
    async activate(openaiId) {
      if (!(await rpc("activate_voice_session", { p_openai_id: openaiId })))
        throw new Error("voice_activation_blocked");
    },
    async fragment(f) {
      await rpc("record_voice_fragment", {
        p_event_id: f.eventId,
        p_role: f.role,
        p_content: f.text,
        p_start_ms: f.startMs,
        p_end_ms: f.endMs,
      });
    },
    async usage(seconds, confirmed) {
      await rpc("update_voice_usage", {
        p_seconds: seconds,
        p_confirmed: confirmed,
      });
    },
    async heartbeat() {
      if (session.access_source === "commercial") {
        // The admission grant survives ordinary preference/billing changes.
        // The database rechecks emergency controls, identity and its deadline.
        const allowed = await rpc("voice_session_continuation_allowed", {});
        if (!allowed) return false;
        const { data, error } = await db.from("voice_sessions")
          .update({ heartbeat_at: new Date().toISOString() })
          .eq("id", session.id)
          .in("status", ["notice", "starting", "active"])
          .select("id");
        if (error) throw new Error("voice_heartbeat_failed");
        return Boolean(data?.length);
      }
      const results = await Promise.all([
        db
          .from("voice_pilot_settings")
          .select("enabled")
          .eq("business_id", session.business_id)
          .single(),
        db
          .from("businesses")
          .select("deleted_at,operations_suspended_at,ai_replies_paused_at")
          .eq("id", session.business_id)
          .single(),
        db
          .from("subscriptions")
          .select("status")
          .eq("business_id", session.business_id)
          .single(),
        db
          .from("voice_sessions")
          .update({ heartbeat_at: new Date().toISOString() })
          .eq("id", session.id)
          .in("status", ["notice", "starting", "active", "closing"])
          .select("id"),
      ]);
      if (results.some((r) => r.error))
        throw new Error("voice_heartbeat_failed");
      const [cfg, business, subscription, current] = results;
      return Boolean(
        cfg.data?.enabled &&
          business.data &&
          !business.data.deleted_at &&
          !business.data.operations_suspended_at &&
          !business.data.ai_replies_paused_at &&
          ["active", "trialing"].includes(subscription.data?.status ?? "") &&
          current.data?.length,
      );
    },
    audioSent() {
      return timestamp("first_audio_at");
    },
    playbackAcknowledged() {
      return timestamp("playback_acknowledged_at");
    },
    async customerAudioStarted(eventId, startedAt) {
      if (session.access_source !== "commercial") return;
      await rpc("record_voice_customer_start", {
        p_event_id: eventId, p_started_at: startedAt,
      });
    },
    async customerPlaybackAcknowledged(eventId) {
      if (session.access_source !== "commercial") return;
      await rpc("acknowledge_voice_customer_start", { p_event_id: eventId });
    },
    async customerTermination(eventId, terminatedAt) {
      if (session.access_source !== "commercial") return;
      await rpc("record_voice_customer_termination", {
        p_event_id: eventId, p_terminated_at: terminatedAt,
      });
    },
    async finish(outcome, error, fallback) {
      await rpc("finalize_voice_session", {
        p_outcome: outcome,
        p_error: error,
        p_fallback: fallback && (session.access_source !== "commercial" || session.text_fallback_enabled === true),
        p_no_provider_started: false,
      });
    },
  };
}
