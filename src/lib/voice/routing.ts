import type { SupabaseClient } from "@supabase/supabase-js";
import type Telnyx from "telnyx";
import {
  PILOT_BUSINESS_ID,
  PILOT_PHONE,
  RECORDING_NOTICE,
  type VoiceSession,
} from "./types";
import { issueStreamToken } from "./store";
import type { AudioProfileName } from "./audio";
import { VOICE_PROVIDER_OPTIONS } from "./provider";

export interface PilotRoutingDependencies {
  db: SupabaseClient;
  telnyx: Telnyx;
  sendFallback: (session: VoiceSession) => Promise<void>;
  workerReady: () => Promise<boolean>;
  appUrl: string;
  workerUrl: string;
  streamSecret: string;
  profile: AudioProfileName;
}

export async function checkVoiceWorkerReady(
  workerUrl: string,
  token: string,
): Promise<boolean> {
  if (!workerUrl || token.length < 32) return false;
  try {
    const url = new URL("/ready", workerUrl);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return (
      body.ready === true &&
      body.model === "gpt-live-1" &&
      body.profile === (process.env.VOICE_AUDIO_PROFILE || "pcm16")
    );
  } catch {
    return false;
  }
}

export async function admitPilot(
  deps: PilotRoutingDependencies,
  args: {
    businessId: string;
    called: string;
    caller: string;
    callControlId: string;
    callSessionId: string;
  },
): Promise<VoiceSession | null> {
  if (args.businessId !== PILOT_BUSINESS_ID || args.called !== PILOT_PHONE)
    return null;
  const [
    { data: settings, error: settingsError },
    { data: tester, error: testerError },
  ] = await Promise.all([
    deps.db
      .from("voice_pilot_settings")
      .select("enabled")
      .eq("business_id", args.businessId)
      .maybeSingle(),
    deps.db
      .from("voice_pilot_testers")
      .select("phone_number")
      .eq("business_id", args.businessId)
      .eq("phone_number", args.caller)
      .maybeSingle(),
  ]);
  if (settingsError || testerError)
    throw new Error("voice_admission_lookup_failed");
  const ready = settings?.enabled && tester ? await deps.workerReady() : false;
  const { data, error } = await deps.db.rpc("admit_voice_pilot", {
    p_business_id: args.businessId,
    p_call_control_id: args.callControlId,
    p_call_session_id: args.callSessionId,
    p_caller: args.caller,
    p_called: args.called,
    p_worker_ready: Boolean(ready),
  });
  if (error) throw new Error("voice_admission_failed");
  return data?.id ? (data as VoiceSession) : null;
}

export function pilotClientState(session: VoiceSession, phase: string): string {
  return Buffer.from(
    JSON.stringify({
      voicePilotSessionId: session.id,
      voicePilotPhase: phase,
      callControlId: session.call_control_id,
      businessId: session.business_id,
    }),
  ).toString("base64");
}

function stateFrom(payload: Record<string, unknown>): {
  voicePilotSessionId?: string;
  voicePilotPhase?: string;
} {
  try {
    const value = JSON.parse(
      Buffer.from(String(payload.client_state ?? ""), "base64").toString(),
    );
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Returns true only when the stored voice decision owns this callback. */
export async function handlePilotEvent(
  deps: PilotRoutingDependencies,
  eventType: string,
  payload: Record<string, unknown>,
  allowLookup: boolean,
): Promise<boolean> {
  if (eventType === "call.initiated") return false;
  const state = stateFrom(payload);
  if (!allowLookup && !state.voicePilotSessionId) return false;
  const callId =
    typeof payload.call_control_id === "string"
      ? payload.call_control_id
      : null;
  if (!callId && !state.voicePilotSessionId) return false;
  const query = deps.db.from("voice_sessions").select("*");
  const { data, error } = await (
    callId
      ? query.eq("call_control_id", callId)
      : query.eq("id", state.voicePilotSessionId!)
  ).maybeSingle();
  if (error) throw new Error("voice_callback_lookup_failed");
  if (!data) {
    if (state.voicePilotSessionId)
      throw new Error("voice_callback_session_missing");
    return false;
  }
  const session = data as VoiceSession;
  if (state.voicePilotSessionId && state.voicePilotSessionId !== session.id)
    throw new Error("voice_callback_identity_mismatch");
  if (
    payload.call_session_id &&
    payload.call_session_id !== session.call_session_id
  )
    throw new Error("voice_callback_identity_mismatch");
  if (session.response_mode !== "voice") {
    if (eventType === "call.hangup")
      await finalize(deps, session, "text_flow", false, true);
    return false;
  }

  // Recording callbacks belong to the voice session even after hangup or
  // rollback. They never enter the voicemail handler or send a generic SMS.
  if (eventType === "call.recording.saved") {
    const recordingId = payload.recording_id;
    if (typeof recordingId !== "string" || !recordingId)
      throw new Error("voice_recording_id_missing");
    const { error: recordingError } = await deps.db
      .from("voice_recordings")
      .upsert(
        {
          recording_id: recordingId,
          session_id: session.id,
          business_id: session.business_id,
          delete_after: new Date(
            Date.parse(session.created_at) + 30 * 86400_000,
          ).toISOString(),
        },
        { onConflict: "recording_id", ignoreDuplicates: true },
      );
    if (recordingError) throw new Error("voice_recording_save_failed");
    return true;
  }
  if (eventType === "call.hangup") {
    const endedAt =
      typeof payload.end_time === "string" &&
      Number.isFinite(Date.parse(payload.end_time))
        ? payload.end_time
        : new Date().toISOString();
    const { error: endedError } = await deps.db
      .from("voice_sessions")
      .update({
        phone_ended_at: endedAt,
        provider_hangup_confirmed_at: new Date().toISOString(),
      })
      .eq("id", session.id);
    if (endedError) throw new Error("voice_hangup_save_failed");
    if (session.status !== "closed") {
      const preStream = ["ringing", "notice"].includes(session.status);
      // Hanging up during the initial ring preserves the existing abandoned
      // call behavior. A normally handled voice call never requests text-back.
      await finalize(
        deps,
        session,
        preStream ? "caller_abandoned" : "caller_hangup",
        false,
        preStream,
      );
    }
    await drainFallback(deps, session.id);
    return true;
  }
  if (session.status === "closed" || session.status === "closing") return true;

  try {
    if (eventType === "call.answered" && session.status === "ringing") {
      await deps.telnyx.calls.actions.startPlayback(
        session.call_control_id,
        {
          audio_url: new URL(
            "/audio/voicemail-ringback-11s-v1.wav",
            deps.appUrl,
          ).toString(),
          audio_type: "wav",
          cache_audio: true,
          target_legs: "self",
          command_id: `voice-ring-${session.id}`,
          client_state: pilotClientState(session, "ringing"),
        },
        VOICE_PROVIDER_OPTIONS,
      );
    } else if (
      eventType === "call.playback.ended" &&
      state.voicePilotPhase === "ringing" &&
      ["ringing", "notice"].includes(session.status)
    ) {
      if (
        ["call_hangup", "cancelled", "cancelled_amd"].includes(
          String(payload.status),
        )
      )
        return true;
      if (payload.status !== "completed")
        throw new Error("voice_ringback_failed");
      await transition(deps, session, ["ringing", "notice"], {
        status: "notice",
      });
      await deps.telnyx.calls.actions.speak(
        session.call_control_id,
        {
          payload: RECORDING_NOTICE,
          voice: "AWS.Polly.Joanna-Neural",
          language: "en-US",
          command_id: `voice-notice-${session.id}`,
          client_state: pilotClientState(session, "notice"),
        },
        VOICE_PROVIDER_OPTIONS,
      );
    } else if (
      eventType === "call.speak.ended" &&
      state.voicePilotPhase === "notice" &&
      ["notice", "starting"].includes(session.status)
    ) {
      if (payload.status !== "completed")
        throw new Error("voice_notice_incomplete");
      if (!(await deps.workerReady()))
        throw new Error("voice_worker_unavailable");
      await transition(deps, session, ["notice", "starting"], {
        status: "starting",
        notice_completed_at:
          session.notice_completed_at ?? new Date().toISOString(),
      });
      const token = await issueStreamToken(deps.db, session, deps.streamSecret);
      const url = new URL("/media", deps.workerUrl);
      if (url.protocol !== "https:")
        throw new Error("voice_worker_url_invalid");
      url.protocol = "wss:";
      url.searchParams.set("token", token);
      // Recording starts only after the completed notice event. Store only the
      // provider recording ID when its later callback arrives.
      await deps.telnyx.calls.actions.startRecording(
        session.call_control_id,
        {
          channels: "dual",
          format: "mp3",
          recording_track: "both",
          max_length: session.reserved_seconds + 30,
          play_beep: false,
          command_id: `voice-record-${session.id}`,
          client_state: pilotClientState(session, "conversation"),
        },
        VOICE_PROVIDER_OPTIONS,
      );
      await deps.telnyx.calls.actions.startStreaming(
        session.call_control_id,
        {
          stream_url: url.toString(),
          stream_track: "inbound_track",
          stream_codec: deps.profile === "pcm16" ? "L16" : "PCMU",
          stream_bidirectional_mode: "rtp",
          stream_bidirectional_codec: deps.profile === "pcm16" ? "L16" : "PCMU",
          stream_bidirectional_sampling_rate:
            deps.profile === "pcm16" ? 16000 : 8000,
          command_id: `voice-stream-${session.id}`,
          client_state: pilotClientState(session, "conversation"),
        },
        VOICE_PROVIDER_OPTIONS,
      );
    } else if (
      eventType === "call.streaming.failed" ||
      eventType === "call.recording.error"
    ) {
      throw new Error(
        eventType === "call.streaming.failed"
          ? "voice_stream_failed"
          : "voice_recording_failed",
      );
    } else if (eventType === "call.streaming.stopped") {
      // Normal disconnects race hangup and final usage. The worker/heartbeat
      // recovery owns finalization; this callback must not guess a failure.
      return true;
    }
  } catch (error) {
    const code =
      error instanceof Error && /^voice_[a-z_]+$/.test(error.message)
        ? error.message
        : "voice_call_command_failed";
    await finalize(
      deps,
      session,
      "technical_failure",
      true,
      ["ringing", "notice"].includes(session.status),
      code,
    );
    await hangup(deps, session);
    await drainFallback(deps, session.id);
  }
  return true;
}

async function transition(
  deps: PilotRoutingDependencies,
  session: VoiceSession,
  statuses: string[],
  values: Record<string, unknown>,
) {
  const { data, error } = await deps.db
    .from("voice_sessions")
    .update({ ...values, heartbeat_at: new Date().toISOString() })
    .eq("id", session.id)
    .in("status", statuses)
    .select("id");
  if (error || !data?.length) throw new Error("voice_state_transition_failed");
}
async function finalize(
  deps: PilotRoutingDependencies,
  session: VoiceSession,
  outcome: string,
  fallback: boolean,
  noProvider: boolean,
  error: string | null = null,
) {
  const { error: failure } = await deps.db.rpc("finalize_voice_session", {
    p_session_id: session.id,
    p_outcome: outcome,
    p_error: error,
    p_fallback: fallback,
    p_no_provider_started: noProvider,
  });
  if (failure) throw new Error("voice_finalization_failed");
}
async function hangup(deps: PilotRoutingDependencies, session: VoiceSession) {
  try {
    await deps.telnyx.calls.actions.hangup(
      session.call_control_id,
      {
        command_id: `voice-end-${session.id}`,
      },
      VOICE_PROVIDER_OPTIONS,
    );
  } catch {
    /* Durable maintenance will retry provider cleanup. */
  }
}
export async function drainFallback(
  deps: PilotRoutingDependencies,
  sessionId: string,
) {
  const { data, error } = await deps.db
    .from("voice_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();
  if (error) throw new Error("voice_fallback_lookup_failed");
  if (!data.fallback_pending || data.fallback_completed_at) return;
  // Existing sendMissedCallSMS owns account access, consent/readiness, quota,
  // and delivery idempotency. Every recovery path uses this same call key.
  await deps.sendFallback(data as VoiceSession);
  const { error: saved } = await deps.db
    .from("voice_sessions")
    .update({
      fallback_pending: false,
      fallback_completed_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (saved) throw new Error("voice_fallback_finalize_failed");
}
