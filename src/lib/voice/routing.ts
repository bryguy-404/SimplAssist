import type { SupabaseClient } from "@supabase/supabase-js";
import type Telnyx from "telnyx";
import {
  PILOT_BUSINESS_ID,
  PILOT_PHONE,
  RECORDING_NOTICE,
  usesPublicOpening,
  usesNaturalPublicOpening,
  type VoiceSession,
} from "./types";
import { issueStreamToken } from "./store";
import type { AudioProfileName } from "./audio";
import { VOICE_PROVIDER_OPTIONS } from "./provider";

export interface PilotRoutingDependencies {
  db: SupabaseClient;
  telnyx: Telnyx;
  sendFallback: (
    session: VoiceSession,
    claim: () => Promise<boolean>,
  ) => Promise<void>;
  workerReady: () => Promise<boolean>;
  commercialWorkerReady?: (naturalOpening?: boolean) => Promise<boolean>;
  prepareWorker?: (sessionId: string) => Promise<void>;
  appUrl: string;
  workerUrl: string;
  streamSecret: string;
  profile: AudioProfileName;
}

export async function checkVoiceWorkerReady(
  workerUrl: string,
  token: string,
  commercial = false,
  naturalOpening = false,
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
      (process.env.BOOKING_CONFIRMATION_V2_ENABLED !== "true" || body.bookingProtocol === 1) &&
      (!commercial || (body.commercialProtocol === 2 && body.actionProtocol === 1)) &&
      (!naturalOpening || body.naturalOpeningProtocol === 1) &&
      (process.env.VOICE_ACTIONS_ROLLOUT !== "true" ||
        body.actionProtocol === 1) &&
      body.model === "gpt-live-1" &&
      body.profile === (process.env.VOICE_AUDIO_PROFILE || "pcm16")
    );
  } catch {
    return false;
  }
}

export async function admitCommercialVoice(
  deps: PilotRoutingDependencies,
  args: { businessId: string; called: string; caller: string; callControlId: string; callSessionId: string },
  allowWorkerProbe = true,
): Promise<VoiceSession | null> {
  const { data, error } = await deps.db.rpc("admit_voice_commercial", {
    p_business_id: args.businessId,
    p_call_control_id: args.callControlId,
    p_call_session_id: args.callSessionId,
    p_caller: args.caller,
    p_called: args.called,
    p_worker_ready: allowWorkerProbe && Boolean(await deps.commercialWorkerReady?.()),
  });
  if (error) throw new Error("voice_commercial_admission_failed");
  if (data?.id && (data.access_source !== "commercial" || data.business_id !== args.businessId ||
    data.call_control_id !== args.callControlId || data.call_session_id !== args.callSessionId ||
    data.called_phone !== args.called || data.caller_phone !== args.caller))
    throw new Error("voice_commercial_identity_invalid");
  return data?.id ? data as VoiceSession : null;
}

/** The owner already rang (or legacy ringback completed). Do not ring twice. */
export async function startCommercialVoice(deps: PilotRoutingDependencies, session: VoiceSession) {
  if (session.access_source !== "commercial" || session.response_mode !== "voice")
    throw new Error("voice_commercial_identity_invalid");
  if (usesPublicOpening(session)) {
    if (!(await deps.commercialWorkerReady?.(usesNaturalPublicOpening(session)))) throw new Error("voice_worker_unavailable");
    await transition(deps, session, ["ringing", "notice"], {
      status: "notice", media_start_requested_at: session.media_start_requested_at ?? new Date().toISOString(),
    });
    // Keep useful connecting audio while the one Marin session starts. The
    // worker stops it only after real opening audio is buffered.
    await deps.telnyx.calls.actions.startPlayback(session.call_control_id, {
      audio_url: new URL("/audio/voicemail-ringback-11s-v1.wav", deps.appUrl).toString(),
      loop: 5, command_id: `voice-public-connect-${session.id}`,
      client_state: pilotClientState(session, "public_disclosure"),
    }, VOICE_PROVIDER_OPTIONS);
    await startMedia(deps, session);
    return;
  }
  await handlePilotEvent(deps, "call.playback.ended", {
    call_control_id: session.call_control_id,
    call_session_id: session.call_session_id,
    client_state: pilotClientState(session, "ringing"),
    status: "completed",
  }, true);
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
      .select("enabled,retired_at")
      .eq("business_id", args.businessId)
      .maybeSingle(),
    deps.db
      .from("voice_pilot_testers")
      .select("phone_number,public_notice_rehearsal_until")
      .eq("business_id", args.businessId)
      .eq("phone_number", args.caller)
      .maybeSingle(),
  ]);
  if (settingsError || testerError)
    throw new Error("voice_admission_lookup_failed");
  const rehearsing = tester?.public_notice_rehearsal_until && Date.parse(tester.public_notice_rehearsal_until) > Date.now();
  const ready = settings?.enabled && !settings.retired_at && tester
    ? rehearsing ? await deps.commercialWorkerReady?.() : await deps.workerReady()
    : false;
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
  evidence?: { eventId?: string; occurredAt?: string },
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
    if (session.access_source === "commercial" &&
      ["call.hangup", "call.recording.saved", "call.recording.error"].includes(eventType)) {
      await finalize(deps, session, "text_flow", Boolean(session.text_fallback_enabled), true);
      await hangup(deps, session);
      await drainFallback(deps, session.id);
      return true;
    }
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
    if (session.access_source === "commercial") {
      const originalEnd = typeof payload.end_time === "string"
        ? payload.end_time : evidence?.occurredAt;
      const verifiedEnd = originalEnd && Number.isFinite(Date.parse(originalEnd));
      const { error } = await deps.db.rpc(
        verifiedEnd && evidence?.eventId ? "record_voice_customer_end" : "record_voice_customer_termination",
        {
          p_session_id: session.id,
          p_event_id: evidence?.eventId ?? `hangup:${session.id}`,
          ...(verifiedEnd && evidence?.eventId
            ? { p_ended_at: originalEnd }
            : { p_terminated_at: new Date().toISOString() }),
        },
      );
      if (error) throw new Error("voice_customer_hangup_save_failed");
    } else {
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
    }
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
      // Queue this while the first ringback is still playing. Starting it only
      // from playback.ended would leave another webhook/API gap of dead air.
      // The original completion still triggers setup; the worker stops this
      // continuation only when it has audible greeting audio buffered.
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
          loop: 3,
          command_id: `voice-connecting-ring-${session.id}`,
          client_state: pilotClientState(session, "ringing"),
        },
        VOICE_PROVIDER_OPTIONS,
      );
      // Request preparation after ringing is queued. The worker independently
      // checks the default-off switch and prior tester disclosure.
      if (session.access_source !== "commercial" && !usesPublicOpening(session) && deps.prepareWorker)
        await deps.prepareWorker(session.id).catch(() => {});
    } else if (
      eventType === "call.playback.ended" &&
      state.voicePilotPhase === "ringing" &&
      (["ringing", "notice"].includes(session.status) ||
        (session.status === "starting" &&
          session.prior_disclosure_acknowledged_at))
    ) {
      if (
        ["call_hangup", "cancelled", "cancelled_amd"].includes(
          String(payload.status),
        )
      )
        return true;
      if (payload.status !== "completed")
        throw new Error("voice_ringback_failed");
      if (session.public_notice_rehearsal && usesPublicOpening(session)) {
        if (!(await deps.commercialWorkerReady?.(usesNaturalPublicOpening(session)))) throw new Error("voice_worker_unavailable");
        await transition(deps, session, ["ringing", "notice"], { status: "notice",
          media_start_requested_at: session.media_start_requested_at ?? new Date().toISOString() });
        await startMedia(deps, session);
        return true;
      }
      if (session.access_source !== "commercial" && (
        session.status === "ringing" ||
        session.prior_disclosure_acknowledged_at
      )) {
        if (!(await deps.workerReady()))
          throw new Error("voice_worker_unavailable");
        const { data: prepared, error: preparationError } = await deps.db.rpc(
          "prepare_preinformed_voice_session",
          { p_session_id: session.id },
        );
        if (preparationError)
          throw new Error("voice_prior_disclosure_lookup_failed");
        if (prepared?.id) {
          // Keep the call's actual notice timestamp empty: no announcement played.
          // The DB records the tester's previous acknowledgment separately.
          Object.assign(session, prepared);
          await startMedia(deps, session);
          return true;
        }
        if (session.prior_disclosure_acknowledged_at)
          throw new Error("voice_prior_disclosure_revoked");
      }
      await transition(deps, session, ["ringing", "notice"], {
        status: "notice",
      });
      // Testers who still need the spoken notice hear it without ringback
      // underneath. Recording remains gated by notice completion as before.
      await deps.telnyx.calls.actions.stopPlayback(
        session.call_control_id,
        {
          stop: "all",
          command_id: `voice-notice-ring-stop-${session.id}`,
          client_state: pilotClientState(session, "notice"),
        },
        VOICE_PROVIDER_OPTIONS,
      );
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
      !usesPublicOpening(session) &&
      state.voicePilotPhase === "notice" &&
      ["notice", "starting"].includes(session.status)
    ) {
      if (payload.status !== "completed")
        throw new Error("voice_notice_incomplete");
      if (!(await (session.access_source === "commercial" ? deps.commercialWorkerReady?.() : deps.workerReady())))
        throw new Error("voice_worker_unavailable");
      await transition(deps, session, ["notice", "starting"], {
        status: "starting",
        notice_completed_at:
          session.notice_completed_at ?? new Date().toISOString(),
        media_start_requested_at:
          session.media_start_requested_at ?? new Date().toISOString(),
      });
      await startMedia(deps, session);
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

async function startMedia(
  deps: PilotRoutingDependencies,
  session: VoiceSession,
) {
  const token = await issueStreamToken(deps.db, session, deps.streamSecret);
  const url = new URL("/media", deps.workerUrl);
  if (url.protocol !== "https:") throw new Error("voice_worker_url_invalid");
  url.protocol = "wss:";
  url.searchParams.set("token", token);
  if ((session.access_source !== "commercial" && session.prior_disclosure_acknowledged_at) || usesPublicOpening(session))
    url.searchParams.set("opening_ringback", "v1");
  // Versioned public openings start recording in the authenticated worker.
  // Legacy private recording follows its notice or prior acknowledgment.
  if (!usesPublicOpening(session)) await deps.telnyx.calls.actions.startRecording(
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
    p_fallback: fallback && (session.access_source !== "commercial" || session.text_fallback_enabled === true),
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
  if (
    (data.access_source === "commercial" && !data.text_fallback_enabled) ||
    !data.fallback_pending ||
    data.fallback_completed_at ||
    data.fallback_claimed_at
  )
    return;
  let attempted = false,
    owned = false;
  const claim = async () => {
    attempted = true;
    const { data: claimed, error: failure } = await deps.db
      .from("voice_sessions")
      .update({ fallback_claimed_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("fallback_pending", true)
      .is("fallback_completed_at", null)
      .is("fallback_claimed_at", null)
      .select("id");
    if (failure) throw new Error("voice_fallback_claim_failed");
    owned = !!claimed?.length;
    return owned;
  };
  try {
    if (!data.demo_mode) await deps.sendFallback(data as VoiceSession, claim);
  } catch (error) {
    if (owned) {
      // Ambiguous provider outcome: leave a durable review flag, never release
      // the claim or resend. Preflight failures before claiming remain retryable.
      await deps.db
        .from("voice_sessions")
        .update({ fallback_error_code: "delivery_unconfirmed" })
        .eq("id", sessionId);
    }
    throw error;
  }
  if (attempted && !owned) return;
  const completion = deps.db
    .from("voice_sessions")
    .update({
      fallback_pending: false,
      fallback_completed_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  // A blocked preflight must not mark another handler's in-flight send complete.
  const { error: saved } = await (owned
    ? completion
    : completion.is("fallback_claimed_at", null));
  if (saved) throw new Error("voice_fallback_finalize_failed");
}
