import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { telnyx } from "@/lib/messaging/client";
import {
  markProcessedOnce,
  releaseProcessedEvent,
  RetryableWebhookError,
} from "@/lib/messaging/idempotency";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendMissedCallSMS } from "@/lib/messaging/missed-call";
import {
  buildSmsComplianceCopy,
  resolveComplianceCopyLocale,
} from "@/lib/messaging/complianceCopy";
import { isE164PhoneNumber } from "@/lib/phone/e164";
import {
  canUseFeature,
  resolveBusinessEntitlements,
} from "@/lib/billing/entitlements";
import { resolveBusinessOperationalControls } from "@/lib/account/operationalControls.server";
import type { Language } from "@/types/database";
import { admitPilot, admitCommercialVoice, handlePilotEvent, startCommercialVoice } from "@/lib/voice/routing";
import { pilotRoutingDependencies } from "@/lib/voice/routing.server";
import { hasCustomerVoiceRoutingConfiguration, isCustomerVoiceRolloutEnabledForBusiness } from "@/lib/voice/access.server";

// Telnyx Voice API delivers all call lifecycle events to the same URL.
// We act on a small subset to drive forwarding and the missed-call voicemail flow:
//
//   call.initiated      -> answer (or reject if number isn't configured)
//   call.answered       -> forward if enabled, otherwise play voicemail ringback
//   call.playback.ended -> speak greeting after voicemail ringback
//   call.bridged        -> mark a forwarding attempt connected
//   call.speak.ended    -> start recording
//   call.recording.saved -> hangup + trigger missed-call SMS
//   call.recording.error -> log + still trigger missed-call SMS so customer hears back
//   call.hangup         -> forwarding fallback or terminal log
//
// State (callControlId, businessId, from, businessName) is threaded through every
// command via Base64-encoded client_state because some later events (notably
// call.recording.saved) don't include call_control_id in their payload.
//
// Retry semantics are SELECTIVE (claim/release contract in
// @/lib/messaging/idempotency): failures in the DURABLE_EVENT_TYPES below,
// OR any handler throwing RetryableWebhookError (durable side effects can
// fail under real-time event types — e.g. the missed-call SMS on a
// forwarding dial error under call.answered), release the idempotency
// claim and return 500 so Telnyx redelivers. Transient voicemail-greeting
// failures are explicitly retryable because a stable command ID makes
// redelivery safe; terminal 4xx responses are acknowledged.
// Other real-time call-control failures keep the log-and-200 swallow:
// retrying answer()/reject() seconds later on a dead call cannot help.

const CALL_FORWARD_TIMEOUT_SECS = 18;
const VOICEMAIL_RINGBACK_AUDIO_PATH =
  "/audio/voicemail-ringback-11s-v1.wav";

const DURABLE_EVENT_TYPES = new Set([
  "call.hangup",
  "call.recording.saved",
  "call.recording.error",
]);

type ForwardingRole = "inbound" | "forward_target";
type ForwardingTerminalStatus = "abandoned" | "fallback_triggered" | "error";
type VoicePhase = "pre_voicemail_ringback" | "voicemail_greeting";
type OperationalForwardingStopReason =
  | "account_suspended_before_bridge"
  | "operational_state_unavailable_before_bridge";

interface VoiceState {
  callControlId: string;
  callSessionId?: string;
  businessId: string;
  from: string;
  businessName: string;
  businessEmail?: string | null;
  businessPhoneNumber?: string | null;
  language?: Language;
  smsPhoneNumber?: string;
  telnyxVoiceApplicationId?: string | null;
  callForwardingEnabled?: boolean;
  forwardToNumber?: string | null;
  forwardingRole?: ForwardingRole;
  forwardingAttemptId?: string;
  outboundCallControlId?: string | null;
  voicePhase?: VoicePhase;
  voicePilotSessionId?: string;
  voiceTextFallbackEnabled?: boolean;
}

interface ForwardingAttempt {
  id: string;
  business_id: string;
  inbound_call_control_id: string;
  outbound_call_control_id: string | null;
  call_session_id: string;
  caller_phone: string;
  forward_to_number: string;
  status: string;
  fallback_triggered_at: string | null;
  error_message: string | null;
}

type OperationalForwardingEndResult =
  | { outcome: "operationally_ended"; attempt: ForwardingAttempt }
  | { outcome: "competing_terminal"; attempt: ForwardingAttempt };

function encodeState(state: VoiceState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64");
}

function decodeState(b64: string | undefined): VoiceState | null {
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString()) as VoiceState;
  } catch (err) {
    console.warn("[messaging:voice] Failed to decode client_state:", err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });

  let event: unknown;
  try {
    event = await telnyx.webhooks.unwrap(rawBody, { headers });
  } catch (err) {
    console.warn("[messaging:voice] Signature verification failed:", err);
    return new NextResponse("Forbidden", { status: 403 });
  }

  const eventData = (event as { data?: { id?: string; event_type?: string; occurred_at?: string; payload?: unknown } }).data;
  const eventType = eventData?.event_type;
  const eventId = eventData?.id;
  console.log(`[messaging:voice] event_type=${eventType} event_id=${eventId}`);

  if (eventId) {
    const isFirstTime = await markProcessedOnce(eventId);
    if (!isFirstTime) {
      console.log(`[messaging:voice] Idempotency: event ${eventId} already processed, skipping`);
      return new NextResponse("OK", { status: 200 });
    }
  } else {
    console.warn("[messaging:voice] Missing event.data.id, skipping idempotency check");
  }

  const payload = eventData?.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return new NextResponse("OK", { status: 200 });
  }

  try {
    try {
      // Stored callback ownership survives admission switches being disabled.
      if (await handlePilotEvent(pilotRoutingDependencies(), eventType ?? "", payload, true, {
        eventId, occurredAt: eventData?.occurred_at,
      })) {
        return new NextResponse("OK", { status: 200 });
      }
    } catch (error) {
      throw new RetryableWebhookError("Voice pilot callback needs retry", { cause: error });
    }
    switch (eventType) {
      case "call.initiated":
        await handleCallInitiated(payload);
        break;
      case "call.answered":
        await handleCallAnswered(payload);
        break;
      case "call.playback.ended":
        await handlePlaybackEnded(payload);
        break;
      case "call.bridged":
        await handleCallBridged(payload);
        break;
      case "call.speak.ended":
        await handleSpeakEnded(payload);
        break;
      case "call.recording.saved":
        await handleRecordingSaved(payload);
        break;
      case "call.recording.error":
        await handleRecordingError(payload);
        break;
      case "call.hangup":
        await handleCallHangup(payload);
        break;
      default:
        console.log(`[messaging:voice] Ignoring event type: ${eventType}`);
    }
  } catch (err) {
    console.error(`[messaging:voice] Error handling ${eventType}:`, err);
    const retryable =
      err instanceof RetryableWebhookError ||
      (typeof eventType === "string" && DURABLE_EVENT_TYPES.has(eventType));
    if (retryable) {
      // Record-and-let-retry: release our claim and 500 so Telnyx
      // redelivers. A failed release dead-letters the row permanently
      // (schema limits — see the claim/release contract); still return
      // an explicit 500 rather than lie with a 200.
      if (eventId) {
        try {
          await releaseProcessedEvent(eventId);
        } catch (releaseErr) {
          console.error(
            `[messaging:voice] claim release failed for ${eventId} — event dead-lettered:`,
            releaseErr
          );
        }
      }
      return new NextResponse("Handler Error", { status: 500 });
    }
  }

  return new NextResponse("OK", { status: 200 });
}

async function handleCallInitiated(payload: Record<string, unknown>) {
  if (payload.direction !== "incoming") {
    console.log(`[messaging:voice] Ignoring non-incoming call.initiated`);
    return;
  }

  const callControlId = payload.call_control_id as string;
  const from = payload.from as string;
  const to = payload.to as string;

  console.log(
    `[messaging:voice] call.initiated from=${from} to=${to} call_control_id=${callControlId}`
  );

  const { data: phoneNumberRow, error: phoneLookupError } = await supabaseAdmin
    .from("phone_numbers")
    .select("business_id")
    .eq("phone_number", to)
    .eq("is_active", true)
    .maybeSingle();

  if (phoneLookupError) {
    throw new RetryableWebhookError(
      `[messaging:voice] Failed to resolve destination number ${to}`,
      { cause: phoneLookupError }
    );
  }

  if (!phoneNumberRow) {
    console.warn(`[messaging:voice] No active business for to=${to}, rejecting call`);
    await telnyx.calls.actions.reject(callControlId, { cause: "USER_BUSY" });
    return;
  }

  const businessId = phoneNumberRow.business_id;
  let entitlements;
  try {
    entitlements = await resolveBusinessEntitlements(businessId);
  } catch (error) {
    throw new RetryableWebhookError(
      `[messaging:voice] Failed to resolve paid access for business ${businessId}`,
      { cause: error }
    );
  }

  if (!canUseFeature(entitlements, "missed_call_sms")) {
    console.warn(
      `[messaging:voice] Paid voice execution is paused for business ${businessId}; rejecting incoming call`
    );
    await telnyx.calls.actions.reject(callControlId, { cause: "USER_BUSY" });
    return;
  }

  const { data: business, error: businessLookupError } = await supabaseAdmin
    .from("businesses")
    .select(
      "name, email, phone_number, telnyx_voice_application_id, call_forwarding_enabled, forward_to_number, ai_settings(language)"
    )
    .eq("id", businessId)
    .maybeSingle();

  if (businessLookupError) {
    throw new RetryableWebhookError(
      `[messaging:voice] Failed to load business ${businessId}`,
      { cause: businessLookupError }
    );
  }
  if (!business) {
    throw new RetryableWebhookError(
      `[messaging:voice] Destination ${to} points to missing business ${businessId}`
    );
  }
  const businessName = business?.name ?? "us";
  const aiSettings = Array.isArray(business.ai_settings)
    ? business.ai_settings[0]
    : business.ai_settings;
  const language = (aiSettings?.language ?? "en") as Language;

  let pilotSessionId: string | undefined;
  if (process.env.VOICE_PILOT_ROLLOUT === "true") {
    try {
      const session = await admitPilot(pilotRoutingDependencies(), {
        businessId, called: to, caller: from, callControlId,
        callSessionId: typeof payload.call_session_id === "string" ? payload.call_session_id : callControlId,
      });
      if (session?.response_mode === "voice") pilotSessionId = session.id;
    } catch (error) {
      throw new RetryableWebhookError("Voice pilot admission needs retry", { cause: error });
    }
  }

  const state = encodeState({
    callControlId,
    callSessionId: typeof payload.call_session_id === "string" ? payload.call_session_id : callControlId,
    businessId,
    from,
    businessName,
    businessEmail: business?.email ?? null,
    businessPhoneNumber: business?.phone_number ?? null,
    language,
    smsPhoneNumber: to,
    telnyxVoiceApplicationId: business?.telnyx_voice_application_id ?? null,
    callForwardingEnabled: business?.call_forwarding_enabled ?? false,
    forwardToNumber: business?.forward_to_number ?? null,
    ...(pilotSessionId ? { voicePilotSessionId: pilotSessionId } : {}),
  });
  console.log(
    `[messaging:voice] Answering call for businessId=${businessId} (name='${businessName}')`
  );
  await telnyx.calls.actions.answer(callControlId, { client_state: state });
}

async function handleCallAnswered(payload: Record<string, unknown>) {
  const stateB64 = payload.client_state as string | undefined;
  const state = decodeState(stateB64);
  if (!state) {
    console.warn(`[messaging:voice] call.answered missing client_state`);
    return;
  }

  if (state.forwardingRole === "forward_target") {
    console.log(
      `[messaging:voice] forward target answered attempt=${state.forwardingAttemptId}; awaiting call.bridged`
    );
    return;
  }

  if (shouldAttemptForwarding(state)) {
    await startCallForwarding(payload, state);
    return;
  }

  await startVoicemailRingback(state);
}

function shouldAttemptForwarding(state: VoiceState): boolean {
  if (!state.callForwardingEnabled) return false;

  if (!state.forwardToNumber || !isE164PhoneNumber(state.forwardToNumber)) {
    console.warn(
      `[messaging:voice] forwarding enabled for businessId=${state.businessId} but forward_to_number is missing or invalid; using missed-call voicemail flow`
    );
    return false;
  }

  if (!state.telnyxVoiceApplicationId) {
    console.warn(
      `[messaging:voice] forwarding enabled for businessId=${state.businessId} but telnyx_voice_application_id is missing; using missed-call voicemail flow`
    );
    return false;
  }

  if (!state.smsPhoneNumber) {
    console.warn(
      `[messaging:voice] forwarding enabled for businessId=${state.businessId} but smsPhoneNumber is missing; using missed-call voicemail flow`
    );
    return false;
  }

  if (state.forwardToNumber === state.smsPhoneNumber) {
    console.warn(
      `[messaging:voice] forwarding enabled for businessId=${state.businessId} but forward_to_number equals the SimplAssist number; using missed-call voicemail flow`
    );
    return false;
  }

  return true;
}

function stableVoiceCommandId(
  callControlId: string,
  command: "voicemail_ringback_v1" | "voicemail_greeting_v1"
): string {
  return createHash("sha256")
    .update(`${command}:${callControlId}`)
    .digest("hex");
}

function voiceCommandHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status =
    (error as { status?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : null;
}

function isRetryableVoiceCommandError(error: unknown): boolean {
  const status = voiceCommandHttpStatus(error);
  if (status === null) return true;
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

function voicemailRingbackAudioUrl(): string | null {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) {
    console.warn(
      "[messaging:voice] NEXT_PUBLIC_APP_URL is missing; skipping voicemail ringback"
    );
    return null;
  }

  try {
    const audioUrl = new URL(VOICEMAIL_RINGBACK_AUDIO_PATH, appUrl);
    if (audioUrl.protocol !== "https:" && audioUrl.protocol !== "http:") {
      throw new Error(`unsupported protocol ${audioUrl.protocol}`);
    }
    return audioUrl.toString();
  } catch (error) {
    console.warn(
      "[messaging:voice] NEXT_PUBLIC_APP_URL is invalid; skipping voicemail ringback:",
      error
    );
    return null;
  }
}

async function startVoicemailRingback(state: VoiceState) {
  const audioUrl = voicemailRingbackAudioUrl();
  if (!audioUrl) {
    await speakVoicemailGreeting(state);
    return;
  }

  const ringbackState = encodeState({
    ...state,
    voicePhase: "pre_voicemail_ringback",
  });

  console.log(
    `[messaging:voice] Starting voicemail ringback for callControlId=${state.callControlId}`
  );
  try {
    await telnyx.calls.actions.startPlayback(state.callControlId, {
      audio_url: audioUrl,
      audio_type: "wav",
      cache_audio: true,
      target_legs: "self",
      client_state: ringbackState,
      command_id: stableVoiceCommandId(
        state.callControlId,
        "voicemail_ringback_v1"
      ),
    });
  } catch (error) {
    console.warn(
      `[messaging:voice] voicemail ringback failed to start for callControlId=${state.callControlId}; speaking greeting immediately:`,
      error
    );
    await speakVoicemailGreeting(state);
  }
}

async function handlePlaybackEnded(payload: Record<string, unknown>) {
  const status = payload.status as string | undefined;
  const state = decodeState(payload.client_state as string | undefined);
  if (!state) {
    console.warn(`[messaging:voice] call.playback.ended missing client_state`);
    return;
  }
  if (state.voicePhase !== "pre_voicemail_ringback") {
    console.log(
      `[messaging:voice] call.playback.ended phase=${state.voicePhase ?? "missing"} (skipping voicemail greeting)`
    );
    return;
  }

  switch (status) {
    case "completed":
    case "file_not_found":
    case "failed":
    case "unknown":
      if (status !== "completed") {
        console.warn(
          `[messaging:voice] voicemail ringback ended status=${status}; speaking greeting immediately`
        );
      }
      await speakVoicemailGreeting(state);
      return;
    case "call_hangup":
    case "cancelled":
    case "cancelled_amd":
      console.log(
        `[messaging:voice] voicemail ringback ended status=${status}; call is no longer continuing`
      );
      return;
    default:
      console.warn(
        `[messaging:voice] call.playback.ended unexpected status=${status ?? "missing"} (skipping voicemail greeting)`
      );
  }
}

async function speakVoicemailGreeting(state: VoiceState) {
  if (await selectCommercialUnansweredRoute(state)) return;
  const locale = resolveComplianceCopyLocale(state.language);
  const greeting = state.voicePilotSessionId && state.voiceTextFallbackEnabled === false
    ? locale === "es"
      ? `Has llamado a ${state.businessName}. No podemos atender tu llamada en este momento. Deja un mensaje después del tono.`
      : `You've reached ${state.businessName}. We can't answer your call right now. Please leave a message after the tone.`
    : buildSmsComplianceCopy({
    business: {
      name: state.businessName,
      email: state.businessEmail ?? null,
      phone_number: state.businessPhoneNumber ?? null,
    },
    smsPhoneNumber: state.smsPhoneNumber ?? "this business number",
    privacyUrl: "the business privacy policy",
    language: state.language,
  }).voicemailGreeting;
  const greetingState = encodeState({
    ...state,
    voicePhase: "voicemail_greeting",
  });

  console.log(
    `[messaging:voice] Speaking voicemail greeting for ${state.businessName}`
  );
  try {
    await telnyx.calls.actions.speak(state.callControlId, {
      payload: greeting,
      voice:
        locale === "es"
          ? "AWS.Polly.Lupe-Neural"
          : "AWS.Polly.Joanna-Neural",
      language: locale === "es" ? "es-US" : "en-US",
      client_state: greetingState,
      command_id: stableVoiceCommandId(
        state.callControlId,
        "voicemail_greeting_v1"
      ),
    });
  } catch (error) {
    if (!isRetryableVoiceCommandError(error)) {
      console.warn(
        `[messaging:voice] voicemail greeting rejected with terminal status=${voiceCommandHttpStatus(error)} for callControlId=${state.callControlId}; call is no longer retryable`,
        error
      );
      return;
    }
    throw new RetryableWebhookError(
      `[messaging:voice] Failed to start voicemail greeting for callControlId=${state.callControlId}`,
      { cause: error }
    );
  }
}

/** A server-frozen voice decision is made only once the owner's call is missed. */
async function selectCommercialUnansweredRoute(state: VoiceState): Promise<boolean> {
  if (state.voicePilotSessionId || !state.callSessionId || !state.smsPhoneNumber)
    return false;
  try {
    if (!(await hasCustomerVoiceRoutingConfiguration(state.businessId))) return false;
    const rolloutOpen = await isCustomerVoiceRolloutEnabledForBusiness(state.businessId);
    const deps = pilotRoutingDependencies();
    const session = await admitCommercialVoice(deps, {
      businessId: state.businessId,
      caller: state.from,
      called: state.smsPhoneNumber,
      callControlId: state.callControlId,
      callSessionId: state.callSessionId,
    }, rolloutOpen);
    if (!session) return false;
    // Carry denied-voice decisions too: voicemail callbacks must honor the
    // frozen text fallback choice rather than sending a competing generic SMS.
    state.voicePilotSessionId = session.id;
    state.voiceTextFallbackEnabled = session.text_fallback_enabled === true;
    if (session.response_mode !== "voice") return false;
    await startCommercialVoice(deps, session);
    return true;
  } catch (error) {
    throw new RetryableWebhookError("Commercial voice routing needs retry", { cause: error });
  }
}

async function startCallForwarding(
  payload: Record<string, unknown>,
  state: VoiceState
) {
  const callSessionId = payload.call_session_id as string | undefined;
  const inboundCallLegId = payload.call_leg_id as string | undefined;
  const forwardToNumber = state.forwardToNumber;
  const voiceApplicationId = state.telnyxVoiceApplicationId;
  const smsPhoneNumber = state.smsPhoneNumber;

  if (!callSessionId || !forwardToNumber || !voiceApplicationId || !smsPhoneNumber) {
    console.warn(
      `[messaging:voice] forwarding prerequisites missing for businessId=${state.businessId}; using missed-call voicemail flow`
    );
    await startVoicemailRingback(state);
    return;
  }

  const createdAttempt = await createForwardingAttempt({
    businessId: state.businessId,
    inboundCallControlId: state.callControlId,
    inboundCallLegId,
    callSessionId,
    callerPhone: state.from,
    forwardToNumber,
  });
  const attempt = createdAttempt.attempt;

  if (!createdAttempt.created) {
    if (isOperationallyStoppedForwardingAttempt(attempt)) {
      if (attempt.outbound_call_control_id) {
        await hangupOwnerLegForOperationalCleanup(
          attempt.outbound_call_control_id,
          "forward target from prior operational-state retry"
        );
      }
      console.log(
        `[messaging:voice] forwarding attempt=${attempt.id} was operationally stopped; preserving voicemail-only outcome on redelivery`
      );
      await startVoicemailRingback(state);
      return;
    } else if (attempt.status !== "dialing") {
      console.log(
        `[messaging:voice] forwarding attempt=${attempt.id} is already status=${attempt.status}; skipping redelivery`
      );
      return;
    } else if (attempt.outbound_call_control_id) {
      const transition = await markForwardingEndedForOperationalStop(
        attempt.id,
        "operational_state_unavailable_before_bridge"
      );
      if (transition.outcome === "operationally_ended") {
        await hangupOwnerLegForOperationalCleanup(
          attempt.outbound_call_control_id,
          "forward target recovered from an unmarked retry"
        );
      }
      throw new RetryableWebhookError(
        `[messaging:voice] Recovered an in-flight forwarding attempt=${attempt.id}; retry after owner cleanup`
      );
    }
  }

  let suspendedBeforeDial: boolean;
  try {
    suspendedBeforeDial = await isBusinessOperationsSuspended(state.businessId);
  } catch (error) {
    await markForwardingEndedForOperationalStop(
      attempt.id,
      "operational_state_unavailable_before_bridge"
    );
    throw error;
  }

  if (suspendedBeforeDial) {
    console.log(
      `[messaging:voice] operations suspended before owner dial attempt=${attempt.id}; using voicemail instead of forwarding`
    );
    const transition = await markForwardingEndedForOperationalStop(
      attempt.id,
      "account_suspended_before_bridge"
    );
    if (transition.outcome === "competing_terminal") return;
    await startVoicemailRingback(state);
    return;
  }

  let outboundCallControlId: string | null = null;

  try {
    const targetState = encodeState({
      ...state,
      forwardingRole: "forward_target",
      forwardingAttemptId: attempt.id,
      outboundCallControlId: null,
    });

    console.log(
      `[messaging:voice] forwarding attempt=${attempt.id} dialing owner=${forwardToNumber} timeout=${CALL_FORWARD_TIMEOUT_SECS}s`
    );
    const dialResponse = await telnyx.calls.dial({
      connection_id: voiceApplicationId,
      from: smsPhoneNumber,
      to: forwardToNumber,
      timeout_secs: CALL_FORWARD_TIMEOUT_SECS,
      client_state: targetState,
    });

    outboundCallControlId = dialResponse.data?.call_control_id ?? null;
    if (!outboundCallControlId) {
      throw new Error("Telnyx dial returned no outbound call_control_id");
    }

    await updateForwardingAttemptOutbound(attempt.id, {
      outboundCallControlId,
      outboundCallLegId: dialResponse.data?.call_leg_id ?? null,
    });

    const latestAttempt = await getForwardingAttemptById(attempt.id);
    if (latestAttempt?.fallback_triggered_at) {
      console.log(
        `[messaging:voice] attempt=${attempt.id} already fell back before bridge; canceling owner leg`
      );
      await bestEffortHangup(outboundCallControlId, "forward target after fallback");
      return;
    }

  } catch (err) {
    console.error(
      `[messaging:voice] forwarding attempt=${attempt.id} failed before owner leg was ready:`,
      err
    );
    await triggerForwardingFallback({
      voiceState: state,
      attemptId: attempt.id,
      status: "error",
      reason: err instanceof Error ? err.message : "forwarding dial error",
      hangupInbound: true,
      hangupOutbound: true,
      outboundCallControlId,
    });
    return;
  }

  let suspendedBeforeBridge: boolean;
  try {
    suspendedBeforeBridge = await isBusinessOperationsSuspended(
      state.businessId
    );
  } catch (error) {
    const transition = await markForwardingEndedForOperationalStop(
      attempt.id,
      "operational_state_unavailable_before_bridge"
    );
    if (transition.outcome === "operationally_ended") {
      await hangupOwnerLegForOperationalCleanup(
        outboundCallControlId,
        "forward target after operational-state failure"
      );
    }
    throw error;
  }

  if (suspendedBeforeBridge) {
    console.log(
      `[messaging:voice] operations suspended after owner dial attempt=${attempt.id}; canceling owner leg and continuing voicemail`
    );
    const transition = await markForwardingEndedForOperationalStop(
      attempt.id,
      "account_suspended_before_bridge"
    );
    if (transition.outcome === "competing_terminal") return;
    // Persist the terminal marker before cleanup. Retryable cleanup failures
    // release the event; redelivery retries this owner leg and then continues
    // voicemail without reopening or dialing a second owner leg.
    await hangupOwnerLegForOperationalCleanup(
      outboundCallControlId,
      "forward target after operations suspension"
    );
    await startVoicemailRingback(state);
    return;
  }

  let finalAttempt: ForwardingAttempt;
  try {
    finalAttempt = await getForwardingAttemptByIdStrict(attempt.id);
  } catch (error) {
    const transition = await markForwardingEndedForOperationalStop(
      attempt.id,
      "operational_state_unavailable_before_bridge"
    );
    if (transition.outcome === "operationally_ended") {
      await hangupOwnerLegForOperationalCleanup(
        outboundCallControlId,
        "forward target after final attempt-state failure"
      );
    }
    throw error;
  }

  if (isOperationallyStoppedForwardingAttempt(finalAttempt)) {
    console.log(
      `[messaging:voice] forwarding attempt=${attempt.id} was operationally stopped by a concurrent delivery; preserving voicemail`
    );
    await hangupOwnerLegForOperationalCleanup(
      outboundCallControlId,
      "forward target after concurrent operational stop"
    );
    await startVoicemailRingback(state);
    return;
  }

  if (hasForwardingFallbackWon(finalAttempt)) {
    console.log(
      `[messaging:voice] forwarding attempt=${attempt.id} became terminal before bridge status=${finalAttempt.status}; canceling owner leg`
    );
    await bestEffortHangup(
      outboundCallControlId,
      "forward target after terminal attempt-state fence"
    );
    return;
  }

  if (finalAttempt.status !== "dialing" && finalAttempt.status !== "connected") {
    await hangupOwnerLegForOperationalCleanup(
      outboundCallControlId,
      "forward target after unexpected final attempt state"
    );
    throw new RetryableWebhookError(
      `[messaging:voice] forwarding attempt=${attempt.id} has unexpected pre-bridge status=${finalAttempt.status}`
    );
  }

  try {
    const inboundBridgeState = encodeState({
      ...state,
      forwardingRole: "inbound",
      forwardingAttemptId: attempt.id,
      outboundCallControlId,
    });

    await telnyx.calls.actions.bridge(state.callControlId, {
      call_control_id_to_bridge_with: outboundCallControlId,
      play_ringtone: true,
      prevent_double_bridge: true,
      client_state: inboundBridgeState,
    });
  } catch (err) {
    console.error(
      `[messaging:voice] forwarding attempt=${attempt.id} failed before connection:`,
      err
    );
    await triggerForwardingFallback({
      voiceState: state,
      attemptId: attempt.id,
      status: "error",
      reason: err instanceof Error ? err.message : "forwarding bridge error",
      hangupInbound: true,
      hangupOutbound: true,
      outboundCallControlId,
    });
  }
}

async function isBusinessOperationsSuspended(
  businessId: string
): Promise<boolean> {
  try {
    const controls = await resolveBusinessOperationalControls(businessId);
    return controls.operationsSuspendedAt !== null;
  } catch (error) {
    throw new RetryableWebhookError(
      `[messaging:voice] Failed to resolve operational controls for business ${businessId}`,
      { cause: error }
    );
  }
}

async function handleCallBridged(payload: Record<string, unknown>) {
  const state = decodeState(payload.client_state as string | undefined);
  const attempt = await findForwardingAttempt(payload, state);

  if (!attempt) {
    console.log(
      `[messaging:voice] call.bridged with no forwarding attempt session=${payload.call_session_id}`
    );
    return;
  }

  await markForwardingConnected(attempt.id, "call_bridged");
}

async function handleCallHangup(payload: Record<string, unknown>) {
  const state = decodeState(payload.client_state as string | undefined);
  const attempt = await findForwardingAttempt(payload, state);

  if (!attempt) {
    console.log(
      `[messaging:voice] call.hangup leg=${payload.call_leg_id} session=${payload.call_session_id}`
    );
    return;
  }

  const callControlId = payload.call_control_id as string | undefined;
  const cause =
    (payload.hangup_cause as string | undefined) ??
    (payload.cause as string | undefined) ??
    "unknown";

  if (attempt.status === "ended") {
    console.log(
      `[messaging:voice] forwarding attempt=${attempt.id} already ended; ignoring additional hangup cause=${cause}`
    );
    return;
  }

  if (attempt.fallback_triggered_at) {
    console.log(
      `[messaging:voice] forwarding attempt=${attempt.id} fallback already triggered; ignoring hangup cause=${cause}`
    );
    return;
  }

  const isInboundHangup = callControlId
    ? callControlId === attempt.inbound_call_control_id
    : state?.forwardingRole === "inbound" &&
      state.forwardingAttemptId === attempt.id;
  const isOutboundHangup = callControlId
    ? callControlId === attempt.outbound_call_control_id
    : state?.forwardingRole === "forward_target" &&
      state.forwardingAttemptId === attempt.id;

  if (attempt.status === "connected" && !isOutboundHangup) {
    await markForwardingEnded(attempt.id);
    console.log(
      `[messaging:voice] forwarding attempt=${attempt.id} connected call ended cause=${cause}`
    );
    return;
  }

  if (isInboundHangup) {
    console.log(
      `[messaging:voice] caller abandoned forwarding attempt=${attempt.id}; canceling owner leg`
    );
    await triggerForwardingFallback({
      attemptId: attempt.id,
      status: "abandoned",
      reason: `caller_hangup_before_bridge:${cause}`,
      hangupInbound: false,
      hangupOutbound: true,
    });
    return;
  }

  if (isOutboundHangup) {
    const operationsSuspended = await isBusinessOperationsSuspended(
      attempt.business_id
    );
    if (operationsSuspended) {
      console.log(
        `[messaging:voice] owner leg ended while operations are suspended attempt=${attempt.id}; preserving inbound voicemail`
      );
      const transition = await markForwardingEndedForOperationalStop(
        attempt.id,
        "account_suspended_before_bridge"
      );
      if (transition.outcome === "competing_terminal") return;
      await startVoicemailRingback(
        voiceStateForForwardingVoicemail(state, attempt)
      );
      return;
    }

    if (attempt.status === "connected") {
      await markForwardingEnded(attempt.id);
      console.log(
        `[messaging:voice] forwarding attempt=${attempt.id} connected owner leg ended cause=${cause}`
      );
      return;
    }

    console.log(
      `[messaging:voice] owner leg ended before bridge attempt=${attempt.id} cause=${cause}; triggering missed-call fallback`
    );
    await triggerForwardingFallback({
      voiceState: voiceStateForForwardingVoicemail(state, attempt),
      attemptId: attempt.id,
      status: "fallback_triggered",
      reason: `owner_hangup_before_bridge:${cause}`,
      hangupInbound: true,
      hangupOutbound: false,
    });
    return;
  }

  console.log(
    `[messaging:voice] forwarding attempt=${attempt.id} hangup did not match known leg cause=${cause}`
  );
}

function voiceStateForForwardingVoicemail(
  state: VoiceState | null,
  attempt: ForwardingAttempt
): VoiceState {
  const matchingState =
    state?.businessId === attempt.business_id &&
    state.callControlId === attempt.inbound_call_control_id
      ? state
      : null;

  return {
    ...(matchingState ?? {}),
    callControlId: attempt.inbound_call_control_id,
    callSessionId: attempt.call_session_id,
    businessId: attempt.business_id,
    from: attempt.caller_phone,
    businessName: matchingState?.businessName ?? "us",
    forwardingRole: undefined,
    forwardingAttemptId: undefined,
    outboundCallControlId: undefined,
    voicePhase: undefined,
  };
}

async function handleSpeakEnded(payload: Record<string, unknown>) {
  const status = payload.status;
  const stateB64 = payload.client_state as string | undefined;
  const state = decodeState(stateB64);

  if (status !== "completed") {
    console.log(
      `[messaging:voice] call.speak.ended status=${status} (skipping recording)`
    );
    return;
  }
  if (!state) {
    console.warn(`[messaging:voice] call.speak.ended missing client_state`);
    return;
  }
  if (
    state.voicePhase !== undefined &&
    state.voicePhase !== "voicemail_greeting"
  ) {
    console.log(
      `[messaging:voice] call.speak.ended phase=${state.voicePhase} (skipping recording)`
    );
    return;
  }

  console.log(
    `[messaging:voice] Starting recording for callControlId=${state.callControlId}`
  );
  await telnyx.calls.actions.startRecording(state.callControlId, {
    channels: "single",
    format: "mp3",
    max_length: 60,
    timeout_secs: 5,
    play_beep: true,
    client_state: stateB64,
  });
}

async function handleRecordingSaved(payload: Record<string, unknown>) {
  const stateB64 = payload.client_state as string | undefined;
  const state = decodeState(stateB64);
  if (!state) {
    console.warn(`[messaging:voice] call.recording.saved missing client_state`);
    return;
  }

  // Voicemail recording URL is NOT persisted to the database in this migration —
  // it's logged only. Persisting voicemails (so they're surfaced in the dashboard)
  // is tracked as future work outside this migration.
  console.log(
    `[messaging:voice] call.recording.saved (not persisted) from=${state.from} businessId=${state.businessId} urls=`,
    payload.recording_urls
  );

  // Hangup is a best-effort cleanup. The caller has typically already hung up by
  // the time recording.saved fires (caller hangs up -> recording finalizes -> we
  // get this event), in which case Telnyx returns 422 "Call has already ended".
  // Swallowing the error here prevents it from bubbling and blocking the
  // missed-call SMS, which is the actually-important side effect.
  try {
    await telnyx.calls.actions.hangup(state.callControlId, {});
  } catch (err) {
    console.log(
      `[messaging:voice] hangup skipped (call likely already ended):`,
      err instanceof Error ? err.message : err
    );
  }

  console.log(
    `[messaging:voice] Triggering missed-call SMS to ${state.from} for ${state.businessId}`
  );
  // Awaited so a send failure propagates: the dispatcher releases the event
  // claim and 500s, and Telnyx's redelivered recording event re-attempts.
  await sendMissedCallSMS(
    state.from,
    state.businessId,
    voicemailMetricSourceId(payload, state.callControlId)
  );
}

async function handleRecordingError(payload: Record<string, unknown>) {
  const stateB64 = payload.client_state as string | undefined;
  const state = decodeState(stateB64);
  if (!state) {
    console.warn(`[messaging:voice] call.recording.error missing client_state`);
    return;
  }

  console.error(`[messaging:voice] call.recording.error:`, payload);

  // Send the missed-call SMS even though recording failed, so the customer
  // still hears back from the business.
  console.log(
    `[messaging:voice] Triggering missed-call SMS despite recording error`
  );
  // Awaited so a send failure propagates (release + 500 + Telnyx retry).
  await sendMissedCallSMS(
    state.from,
    state.businessId,
    voicemailMetricSourceId(payload, state.callControlId)
  );
}

function voicemailMetricSourceId(
  payload: Record<string, unknown>,
  fallbackCallControlId: string
): string {
  const callSessionId = payload.call_session_id;
  return typeof callSessionId === "string" && callSessionId.trim()
    ? callSessionId
    : fallbackCallControlId;
}

async function createForwardingAttempt(args: {
  businessId: string;
  inboundCallControlId: string;
  inboundCallLegId?: string;
  callSessionId: string;
  callerPhone: string;
  forwardToNumber: string;
}): Promise<{ attempt: ForwardingAttempt; created: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .insert({
      business_id: args.businessId,
      inbound_call_control_id: args.inboundCallControlId,
      inbound_call_leg_id: args.inboundCallLegId ?? null,
      outbound_call_control_id: null,
      outbound_call_leg_id: null,
      call_session_id: args.callSessionId,
      caller_phone: args.callerPhone,
      forward_to_number: args.forwardToNumber,
      status: "dialing",
      fallback_triggered_at: null,
      abandoned_at: null,
      connected_at: null,
      ended_at: null,
      error_message: null,
    })
    .select(forwardingAttemptSelect)
    .single();

  if (error?.code === "23505") {
    const existing = await getForwardingAttemptByColumnStrict(
      "call_session_id",
      args.callSessionId
    );
    return { attempt: existing, created: false };
  }

  if (error || !data) {
    throw new RetryableWebhookError(
      `[messaging:voice] failed to create forwarding attempt: ${error?.message ?? "no row returned"}`,
      { cause: error ?? undefined }
    );
  }

  return { attempt: data as ForwardingAttempt, created: true };
}

async function updateForwardingAttemptOutbound(
  attemptId: string,
  args: { outboundCallControlId: string; outboundCallLegId: string | null }
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .update({
      outbound_call_control_id: args.outboundCallControlId,
      outbound_call_leg_id: args.outboundCallLegId,
    })
    .eq("id", attemptId);

  if (error) {
    throw new Error(
      `[messaging:voice] failed to update forwarding outbound leg: ${error.message}`
    );
  }
}

async function getForwardingAttemptById(
  attemptId: string
): Promise<ForwardingAttempt | null> {
  const { data, error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .select(forwardingAttemptSelect)
    .eq("id", attemptId)
    .maybeSingle();

  if (error) {
    console.warn(
      `[messaging:voice] failed to read forwarding attempt ${attemptId}:`,
      error
    );
    return null;
  }

  return (data as ForwardingAttempt | null) ?? null;
}

async function findForwardingAttempt(
  payload: Record<string, unknown>,
  state: VoiceState | null
): Promise<ForwardingAttempt | null> {
  if (state?.forwardingAttemptId) {
    const attempt = await getForwardingAttemptById(state.forwardingAttemptId);
    if (attempt) return attempt;
  }

  const callControlId = payload.call_control_id as string | undefined;
  if (callControlId) {
    const byInbound = await getForwardingAttemptByColumn(
      "inbound_call_control_id",
      callControlId
    );
    if (byInbound) return byInbound;

    const byOutbound = await getForwardingAttemptByColumn(
      "outbound_call_control_id",
      callControlId
    );
    if (byOutbound) return byOutbound;
  }

  const callSessionId = payload.call_session_id as string | undefined;
  if (callSessionId) {
    return getForwardingAttemptByColumn("call_session_id", callSessionId);
  }

  return null;
}

async function getForwardingAttemptByColumn(
  column:
    | "inbound_call_control_id"
    | "outbound_call_control_id"
    | "call_session_id",
  value: string
): Promise<ForwardingAttempt | null> {
  const { data, error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .select(forwardingAttemptSelect)
    .eq(column, value)
    .maybeSingle();

  if (error) {
    console.warn(
      `[messaging:voice] forwarding attempt lookup failed ${column}=${value}:`,
      error
    );
    return null;
  }

  return (data as ForwardingAttempt | null) ?? null;
}

async function getForwardingAttemptByColumnStrict(
  column: "call_session_id",
  value: string
): Promise<ForwardingAttempt> {
  const { data, error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .select(forwardingAttemptSelect)
    .eq(column, value)
    .maybeSingle();

  if (error || !data) {
    throw new RetryableWebhookError(
      `[messaging:voice] failed to recover existing forwarding attempt ${column}=${value}`,
      { cause: error ?? undefined }
    );
  }

  return data as ForwardingAttempt;
}

async function markForwardingConnected(
  attemptId: string,
  source: string
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .update({
      status: "connected",
      connected_at: new Date().toISOString(),
    })
    .eq("id", attemptId)
    .eq("status", "dialing")
    .is("fallback_triggered_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    // Retryable: a lost connected-mark makes a later hangup fire a spurious
    // missed-call SMS. The CAS (status='dialing') makes the retry a no-op
    // when the first write actually committed.
    throw new RetryableWebhookError(
      `[messaging:voice] failed to mark forwarding attempt=${attemptId} connected: ${error.message}`
    );
  }

  if (!data) {
    console.log(
      `[messaging:voice] forwarding attempt=${attemptId} not marked connected; already fell back or ended`
    );
    return;
  }

  console.log(
    `[messaging:voice] forwarding attempt=${attemptId} connected source=${source}`
  );
}

async function markForwardingEnded(attemptId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .update({
      status: "ended",
      ended_at: new Date().toISOString(),
    })
    .eq("id", attemptId)
    .eq("status", "connected");

  if (error) {
    // Retryable: silently losing the 'ended' transition strands the attempt
    // in 'connected' — the durable bookkeeping this route promises to
    // record-and-let-retry. CAS (status='connected') no-ops a redundant retry.
    throw new RetryableWebhookError(
      `[messaging:voice] failed to mark forwarding attempt=${attemptId} ended: ${error.message}`
    );
  }
}

function isOperationallyStoppedForwardingAttempt(
  attempt: ForwardingAttempt
): attempt is ForwardingAttempt & { error_message: OperationalForwardingStopReason } {
  return (
    attempt.status === "ended" &&
    (attempt.error_message === "account_suspended_before_bridge" ||
      attempt.error_message === "operational_state_unavailable_before_bridge")
  );
}

function hasForwardingFallbackWon(attempt: ForwardingAttempt): boolean {
  return (
    attempt.fallback_triggered_at !== null ||
    attempt.status === "fallback_triggered" ||
    attempt.status === "abandoned" ||
    attempt.status === "error" ||
    attempt.status === "ended"
  );
}

async function markForwardingEndedForOperationalStop(
  attemptId: string,
  reason: OperationalForwardingStopReason
): Promise<OperationalForwardingEndResult> {
  const { data, error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .update({
      status: "ended",
      ended_at: new Date().toISOString(),
      error_message: reason,
    })
    .eq("id", attemptId)
    .in("status", ["dialing", "connected"])
    .is("fallback_triggered_at", null)
    .select(forwardingAttemptSelect)
    .maybeSingle();

  if (error) {
    throw new RetryableWebhookError(
      `[messaging:voice] failed to end operationally blocked forwarding attempt=${attemptId}: ${error.message}`,
      { cause: error }
    );
  }

  if (data) {
    return {
      outcome: "operationally_ended",
      attempt: data as ForwardingAttempt,
    };
  }

  const latest = await getForwardingAttemptByIdStrict(attemptId);
  if (isOperationallyStoppedForwardingAttempt(latest)) {
    return { outcome: "operationally_ended", attempt: latest };
  }
  if (
    latest.fallback_triggered_at ||
    latest.status === "fallback_triggered" ||
    latest.status === "abandoned" ||
    latest.status === "error" ||
    latest.status === "ended"
  ) {
    console.log(
      `[messaging:voice] operational stop lost to terminal attempt=${attemptId} status=${latest.status}`
    );
    return { outcome: "competing_terminal", attempt: latest };
  }

  // The update explicitly accepts both dialing and connected. Seeing either
  // after a zero-row result means a concurrent transition escaped the CAS; do
  // not bridge, hang up, or acknowledge without a retryable re-evaluation.
  throw new RetryableWebhookError(
    `[messaging:voice] operational stop did not claim live forwarding attempt=${attemptId} status=${latest.status}`
  );
}

async function getForwardingAttemptByIdStrict(
  attemptId: string
): Promise<ForwardingAttempt> {
  const { data, error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .select(forwardingAttemptSelect)
    .eq("id", attemptId)
    .maybeSingle();

  if (error || !data) {
    throw new RetryableWebhookError(
      `[messaging:voice] failed to confirm forwarding attempt=${attemptId} after operational transition`,
      { cause: error ?? undefined }
    );
  }

  return data as ForwardingAttempt;
}

async function triggerForwardingFallback(args: {
  voiceState?: VoiceState;
  attemptId: string;
  status: ForwardingTerminalStatus;
  reason: string;
  hangupInbound: boolean;
  hangupOutbound: boolean;
  outboundCallControlId?: string | null;
}): Promise<void> {
  const now = new Date().toISOString();
  const updateData: Record<string, string | null> = {
    status: args.status,
    fallback_triggered_at: now,
    error_message: args.reason,
  };

  if (args.status === "abandoned") {
    updateData.abandoned_at = now;
  }

  const { data, error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .update(updateData)
    .eq("id", args.attemptId)
    .is("fallback_triggered_at", null)
    .in("status", ["dialing", "error"])
    .select(forwardingAttemptSelect)
    .maybeSingle();

  if (error) {
    // Throw — a swallowed claim error loses the fallback (and its SMS)
    // while the event is already consumed; the dispatcher releases the
    // event claim and 500s so the redelivered hangup retries.
    throw new Error(
      `[messaging:voice] failed to claim forwarding fallback attempt=${args.attemptId}: ${error.message}`
    );
  }

  const attempt = (data as ForwardingAttempt | null) ?? null;
  if (!attempt) {
    console.log(
      `[messaging:voice] forwarding fallback already claimed or connected attempt=${args.attemptId}`
    );
    return;
  }

  const outboundCallControlId =
    args.outboundCallControlId ?? attempt.outbound_call_control_id;

  if (args.hangupOutbound && outboundCallControlId) {
    await bestEffortHangup(outboundCallControlId, "forward target cleanup");
  }
  if (args.status !== "abandoned" && args.voiceState) {
    try {
      const routeState = voiceStateForForwardingVoicemail(args.voiceState, attempt);
      if (await selectCommercialUnansweredRoute(routeState)) return;
      if (routeState.voicePilotSessionId) {
        // Voice was selected but unavailable. Its frozen fallback decision is
        // honored by the voicemail completion callback, without ending caller.
        await speakVoicemailGreeting(routeState);
        return;
      }
    } catch (error) {
      await reopenForwardingFallbackAfterSmsFailure(attempt.id, error);
      throw new RetryableWebhookError("Forwarded voice routing needs retry", { cause: error });
    }
  }
  if (args.hangupInbound) {
    await bestEffortHangup(
      attempt.inbound_call_control_id,
      "inbound forwarding cleanup"
    );
  }

  console.log(
    `[messaging:voice] forwarding fallback attempt=${attempt.id} status=${args.status} reason=${args.reason}; sending missed-call SMS`
  );
  try {
    await sendMissedCallSMS(
      attempt.caller_phone,
      attempt.business_id,
      attempt.call_session_id
    );
  } catch (err) {
    // Record the failure AND re-open the fallback claim: handleCallHangup
    // short-circuits on fallback_triggered_at, so without clearing it the
    // redelivered hangup would ack without re-attempting the SMS. Status
    // 'error' + error_message record what happened; the retry re-enters
    // this claim (fallback_triggered_at null, status='error') and
    // re-sends. Lost-ack caveat: if the SMS actually sent but our client
    // saw an error, the retry double-texts — annoying, and strictly better
    // than a caller who never hears back. Thrown as RetryableWebhookError:
    // this path is reachable under call.answered (forwarding dial error),
    // where a plain throw would be swallowed as a real-time verb failure.
    await reopenForwardingFallbackAfterSmsFailure(attempt.id, err);
    throw new RetryableWebhookError(
      `[messaging:voice] missed-call SMS failed for attempt=${attempt.id}`,
      { cause: err }
    );
  }
}

async function reopenForwardingFallbackAfterSmsFailure(
  attemptId: string,
  cause: unknown
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("call_forwarding_attempts")
    .update({
      status: "error",
      fallback_triggered_at: null,
      abandoned_at: null,
      error_message: `missed_call_sms_failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    })
    .eq("id", attemptId)
    // Defensive symmetry with the claim's own guard: never overwrite a
    // connected attempt (unreachable today per the state machine, cheap
    // to enforce structurally).
    .neq("status", "connected");

  if (error) {
    // The original SMS error still propagates (release + 500), but with the
    // claim timestamp intact the redelivered hangup will short-circuit —
    // this attempt's SMS is lost until the reaper follow-up. Log loudly.
    console.error(
      `[messaging:voice] FAILED TO RE-OPEN fallback attempt=${attemptId} after SMS failure — retry will not re-attempt this SMS:`,
      error
    );
  }
}

async function bestEffortHangup(
  callControlId: string,
  label: string
): Promise<void> {
  try {
    await telnyx.calls.actions.hangup(callControlId, {});
  } catch (err) {
    console.log(
      `[messaging:voice] hangup skipped for ${label}:`,
      err instanceof Error ? err.message : err
    );
  }
}

async function hangupOwnerLegForOperationalCleanup(
  callControlId: string,
  label: string
): Promise<void> {
  try {
    await telnyx.calls.actions.hangup(callControlId, {});
  } catch (error) {
    const status = voiceCommandHttpStatus(error);
    if (status === 404 || status === 410 || status === 422) {
      console.log(
        `[messaging:voice] owner-leg cleanup already terminal for ${label} status=${status}`
      );
      return;
    }
    throw new RetryableWebhookError(
      `[messaging:voice] owner-leg cleanup failed for ${label}`,
      { cause: error }
    );
  }
}

const forwardingAttemptSelect =
  "id, business_id, inbound_call_control_id, outbound_call_control_id, call_session_id, caller_phone, forward_to_number, status, fallback_triggered_at, error_message";
