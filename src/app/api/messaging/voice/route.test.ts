import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  unwrap: vi.fn(),
  reject: vi.fn(),
  answer: vi.fn(),
  hangup: vi.fn(),
  startPlayback: vi.fn(),
  speak: vi.fn(),
  startRecording: vi.fn(),
  dial: vi.fn(),
  bridge: vi.fn(),
  markProcessedOnce: vi.fn(),
  releaseProcessedEvent: vi.fn(),
  sendMissedCallSMS: vi.fn(),
  resolveBusinessEntitlements: vi.fn(),
  resolveBusinessOperationalControls: vi.fn(),
  canUseFeature: vi.fn(),
  from: vi.fn(),
  handleStoredVoiceEvent: vi.fn(),
  commercialRollout: vi.fn(),
  commercialConfiguration: vi.fn(),
  admitCommercial: vi.fn(),
  startCommercial: vi.fn(),
}));

vi.mock("@/lib/voice/access.server", () => ({
  isCustomerVoiceRolloutEnabledForBusiness: mocks.commercialRollout,
  hasCustomerVoiceRoutingConfiguration: mocks.commercialConfiguration,
}));
vi.mock("@/lib/voice/routing", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/voice/routing")>(),
  handlePilotEvent: mocks.handleStoredVoiceEvent,
  admitCommercialVoice: mocks.admitCommercial,
  startCommercialVoice: mocks.startCommercial,
}));

vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
    webhooks: { unwrap: mocks.unwrap },
    calls: {
      dial: mocks.dial,
      actions: {
        reject: mocks.reject,
        answer: mocks.answer,
        hangup: mocks.hangup,
        startPlayback: mocks.startPlayback,
        speak: mocks.speak,
        startRecording: mocks.startRecording,
        bridge: mocks.bridge,
      },
    },
  },
}));
vi.mock("@/lib/messaging/idempotency", async (importOriginal) => {
  // Keep the REAL RetryableWebhookError class — the route's instanceof
  // check must see the same constructor the handlers throw.
  const actual =
    await importOriginal<typeof import("@/lib/messaging/idempotency")>();
  return {
    ...actual,
    markProcessedOnce: mocks.markProcessedOnce,
    releaseProcessedEvent: mocks.releaseProcessedEvent,
  };
});
vi.mock("@/lib/messaging/missed-call", () => ({
  sendMissedCallSMS: mocks.sendMissedCallSMS,
}));
vi.mock("@/lib/billing/entitlements", () => ({
  resolveBusinessEntitlements: mocks.resolveBusinessEntitlements,
  canUseFeature: mocks.canUseFeature,
}));
vi.mock("@/lib/account/operationalControls.server", () => ({
  resolveBusinessOperationalControls: mocks.resolveBusinessOperationalControls,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { POST as voiceWebhook } from "./route";
import {
  buildSmsComplianceCopy,
  resolveComplianceCopyLocale,
} from "@/lib/messaging/complianceCopy";
import type { Language } from "@/types/database";

const ATTEMPT = {
  id: "att_1",
  business_id: "00000000-0000-4000-8000-00000000b1z1",
  inbound_call_control_id: "cc_inbound",
  outbound_call_control_id: "cc_outbound",
  call_session_id: "sess_1",
  caller_phone: "+15745550100",
  forward_to_number: "+15745550200",
  status: "dialing",
  fallback_triggered_at: null,
  error_message: null,
};

const ACTIVE_OPERATIONAL_CONTROLS = {
  businessId: ATTEMPT.business_id,
  operationsSuspendedAt: null,
  aiRepliesPausedAt: null,
  textingPausedAt: null,
  bookingsPausedAt: null,
};

const SUSPENDED_OPERATIONAL_CONTROLS = {
  ...ACTIVE_OPERATIONAL_CONTROLS,
  operationsSuspendedAt: "2026-08-04T18:00:00Z",
};

function operationallyEndedAttempt(
  reason:
    | "account_suspended_before_bridge"
    | "operational_state_unavailable_before_bridge",
  overrides: Record<string, unknown> = {}
) {
  return {
    ...ATTEMPT,
    status: "ended",
    error_message: reason,
    ...overrides,
  };
}

// Chainable, awaitable supabase mock; from() consumes queued results FIFO
// and records each chain for argument assertions.
const chains: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
function queueResults(...results: unknown[]) {
  const queue = [...results];
  chains.length = 0;
  mocks.from.mockImplementation(() => {
    const result = queue.shift() ?? { data: null, error: null };
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of [
      "select",
      "update",
      "insert",
      "eq",
      "in",
      "is",
      "neq",
      "maybeSingle",
      "single",
    ]) {
      chain[m] = vi.fn(() => chain);
    }
    const promise = Promise.resolve(result);
    (chain as Record<string, unknown>).then = promise.then.bind(promise);
    (chain as Record<string, unknown>).catch = promise.catch.bind(promise);
    chains.push(chain);
    return chain;
  });
}

function request() {
  return new NextRequest("http://localhost/api/messaging/voice", {
    method: "POST",
    body: "{}",
  });
}

function encodeState(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state)).toString("base64");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function voiceEvent(
  eventType: string,
  payload: Record<string, unknown>,
  id = `evt_voice_${eventType.replaceAll(".", "_")}`
) {
  return { data: { id, event_type: eventType, payload } };
}

const HANGUP_STATE = encodeState({
  callControlId: "cc_inbound",
  businessId: ATTEMPT.business_id,
  from: ATTEMPT.caller_phone,
  businessName: "Test Biz",
  forwardingRole: "inbound",
  forwardingAttemptId: ATTEMPT.id,
});

const RECORDING_STATE = encodeState({
  callControlId: "cc_inbound",
  businessId: ATTEMPT.business_id,
  from: ATTEMPT.caller_phone,
  businessName: "Test Biz",
});

function voicemailState(overrides: Record<string, unknown> = {}) {
  return encodeState({
    callControlId: "cc_voicemail",
    businessId: ATTEMPT.business_id,
    from: ATTEMPT.caller_phone,
    businessName: "Test Biz",
    businessEmail: "owner@example.test",
    businessPhoneNumber: "+15745550400",
    smsPhoneNumber: "+15745550300",
    language: "en",
    callForwardingEnabled: false,
    ...overrides,
  });
}

function forwardingInboundState(overrides: Record<string, unknown> = {}) {
  return voicemailState({
    callControlId: ATTEMPT.inbound_call_control_id,
    callForwardingEnabled: true,
    forwardToNumber: ATTEMPT.forward_to_number,
    telnyxVoiceApplicationId: "voice_app_1",
    ...overrides,
  });
}

function forwardTargetState(overrides: Record<string, unknown> = {}) {
  return encodeState({
    callControlId: ATTEMPT.inbound_call_control_id,
    businessId: ATTEMPT.business_id,
    from: ATTEMPT.caller_phone,
    businessName: "Test Biz",
    forwardingRole: "forward_target",
    forwardingAttemptId: ATTEMPT.id,
    outboundCallControlId: ATTEMPT.outbound_call_control_id,
    ...overrides,
  });
}

describe("closed commercial unanswered-call integration", () => {
  it("waits until existing ringback completes before admitting customer voice", async () => {
    mocks.commercialConfiguration.mockResolvedValue(true);
    mocks.commercialRollout.mockResolvedValue(true);
    mocks.admitCommercial.mockResolvedValue({ id: "customer-call", response_mode: "voice", text_fallback_enabled: true });
    const state = voicemailState({ callSessionId: "original-call" });
    mocks.unwrap.mockResolvedValue(voiceEvent("call.answered", { call_control_id: "cc_voicemail", client_state: state }));
    expect((await voiceWebhook(request())).status).toBe(200);
    expect(mocks.admitCommercial).not.toHaveBeenCalled();
    expect(mocks.startPlayback).toHaveBeenCalledOnce();
    const ringState = mocks.startPlayback.mock.calls[0][1].client_state;
    mocks.unwrap.mockResolvedValue(voiceEvent("call.playback.ended", { call_control_id: "cc_voicemail", status: "completed", client_state: ringState }));
    expect((await voiceWebhook(request())).status).toBe(200);
    expect(mocks.admitCommercial).toHaveBeenCalledWith(expect.anything(), {
      businessId: ATTEMPT.business_id, caller: ATTEMPT.caller_phone,
      called: "+15745550300", callControlId: "cc_voicemail", callSessionId: "original-call",
    }, true);
    expect(mocks.startCommercial).toHaveBeenCalledOnce();
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });
  it("keeps the caller connected when customer voice wins after the owner does not answer", async () => {
    mocks.commercialConfiguration.mockResolvedValue(true);
    mocks.commercialRollout.mockResolvedValue(true);
    mocks.admitCommercial.mockResolvedValue({ id: "customer-call", response_mode: "voice" });
    mocks.unwrap.mockResolvedValue(voiceEvent("call.hangup", {
      call_control_id: ATTEMPT.outbound_call_control_id,
      call_session_id: ATTEMPT.call_session_id,
      client_state: forwardTargetState({ smsPhoneNumber: "+15745550300" }), hangup_cause: "NO_ANSWER",
    }));
    queueResults({ data: ATTEMPT, error: null }, { data: { ...ATTEMPT, status: "fallback_triggered" }, error: null });
    expect((await voiceWebhook(request())).status).toBe(200);
    expect(mocks.admitCommercial).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      callControlId: ATTEMPT.inbound_call_control_id, callSessionId: ATTEMPT.call_session_id,
    }), true);
    expect(mocks.startCommercial).toHaveBeenCalledOnce();
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });
  it("does not intercept a call that the owner answered", async () => {
    mocks.commercialConfiguration.mockResolvedValue(true);
    mocks.commercialRollout.mockResolvedValue(true);
    mocks.unwrap.mockResolvedValue(voiceEvent("call.hangup", {
      call_control_id: ATTEMPT.outbound_call_control_id,
      call_session_id: ATTEMPT.call_session_id, client_state: forwardTargetState(),
    }));
    queueResults({ data: { ...ATTEMPT, status: "connected" }, error: null }, { error: null });
    expect((await voiceWebhook(request())).status).toBe(200);
    expect(mocks.admitCommercial).not.toHaveBeenCalled();
    expect(mocks.startCommercial).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });
  it.each([true, false])("preserves a configured denied-voice fallback after rollout open=%s without promising a text", async (rolloutOpen) => {
    mocks.commercialConfiguration.mockResolvedValue(true);
    mocks.commercialRollout.mockResolvedValue(rolloutOpen);
    mocks.admitCommercial.mockResolvedValue({ id: "denied-call", response_mode: "text", text_fallback_enabled: false });
    mocks.unwrap.mockResolvedValue(voiceEvent("call.playback.ended", {
      call_control_id: "cc_voicemail", status: "completed",
      client_state: voicemailState({ callSessionId: "original-call", voicePhase: "pre_voicemail_ringback" }),
    }));
    expect((await voiceWebhook(request())).status).toBe(200);
    expect(mocks.admitCommercial).toHaveBeenCalledWith(expect.anything(), expect.anything(), rolloutOpen);
    expect(mocks.startCommercial).not.toHaveBeenCalled();
    const spoken = mocks.speak.mock.calls[0][1];
    expect(spoken.payload).not.toMatch(/text|SMS/i);
    expect(JSON.parse(Buffer.from(spoken.client_state, "base64").toString())).toMatchObject({
      voicePilotSessionId: "denied-call", voiceTextFallbackEnabled: false,
    });
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });
  it("keeps the legacy response unchanged while commercial rollout is closed", async () => {
    mocks.unwrap.mockResolvedValue(voiceEvent("call.playback.ended", {
      call_control_id: "cc_voicemail", status: "completed",
      client_state: voicemailState({ callSessionId: "original-call", voicePhase: "pre_voicemail_ringback" }),
    }));
    expect((await voiceWebhook(request())).status).toBe(200);
    expect(mocks.commercialConfiguration).toHaveBeenCalledWith(ATTEMPT.business_id);
    expect(mocks.commercialRollout).not.toHaveBeenCalled();
    expect(mocks.admitCommercial).not.toHaveBeenCalled();
    expect(mocks.speak).toHaveBeenCalledOnce();
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocks.markProcessedOnce.mockResolvedValue(true);
  mocks.releaseProcessedEvent.mockResolvedValue(undefined);
  mocks.sendMissedCallSMS.mockResolvedValue(undefined);
  mocks.handleStoredVoiceEvent.mockResolvedValue(false);
  mocks.commercialRollout.mockResolvedValue(false);
  mocks.commercialConfiguration.mockResolvedValue(false);
  mocks.admitCommercial.mockResolvedValue(null);
  mocks.startCommercial.mockResolvedValue(undefined);
  mocks.resolveBusinessEntitlements.mockResolvedValue({
    businessId: ATTEMPT.business_id,
    plan: "sms_only",
    status: "active",
    source: "subscription",
    active: true,
    cancelAtPeriodEnd: false,
  });
  mocks.resolveBusinessOperationalControls.mockResolvedValue(
    ACTIVE_OPERATIONAL_CONTROLS
  );
  mocks.canUseFeature.mockReturnValue(true);
  mocks.hangup.mockResolvedValue({});
  mocks.reject.mockResolvedValue({});
  mocks.answer.mockResolvedValue({});
  mocks.startPlayback.mockResolvedValue({});
  mocks.speak.mockResolvedValue({});
  mocks.bridge.mockResolvedValue({});
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test/");
  queueResults();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/messaging/voice", () => {
  it("uses forwarding-disabled state to play ringback before the voicemail disclosure", async () => {
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.initiated",
        {
          direction: "incoming",
          from: ATTEMPT.caller_phone,
          to: "+15745550300",
          call_control_id: "cc_forwarding_off",
        },
        "evt_voice_initiated_forwarding_off"
      )
    );
    queueResults(
      { data: { business_id: ATTEMPT.business_id }, error: null },
      {
        data: {
          name: "Test Biz",
          email: "owner@example.test",
          phone_number: "+15745550400",
          telnyx_voice_application_id: "voice_app_1",
          call_forwarding_enabled: false,
          // A saved number must not override the disabled setting.
          forward_to_number: ATTEMPT.forward_to_number,
          ai_settings: { language: null },
        },
        error: null,
      }
    );

    const initiatedResponse = await voiceWebhook(request());

    expect(initiatedResponse.status).toBe(200);
    expect(mocks.answer).toHaveBeenCalledWith(
      "cc_forwarding_off",
      expect.objectContaining({ client_state: expect.any(String) })
    );
    const initiatedState = mocks.answer.mock.calls[0][1]
      .client_state as string;
    const decodedInitiatedState = JSON.parse(
      Buffer.from(initiatedState, "base64").toString()
    );
    expect(decodedInitiatedState).toEqual(
      expect.objectContaining({
        callForwardingEnabled: false,
        forwardToNumber: ATTEMPT.forward_to_number,
        language: "en",
      })
    );

    expect(chains[1].select).toHaveBeenCalledWith(
      "name, email, phone_number, telnyx_voice_application_id, call_forwarding_enabled, forward_to_number, ai_settings(language)"
    );

    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: "cc_forwarding_off",
          call_session_id: "sess_forwarding_off",
          client_state: initiatedState,
        },
        "evt_voice_answered_forwarding_off"
      )
    );
    queueResults();

    const answeredResponse = await voiceWebhook(request());

    expect(answeredResponse.status).toBe(200);
    expect(mocks.startPlayback).toHaveBeenCalledWith(
      "cc_forwarding_off",
      {
        audio_url:
          "https://app.example.test/audio/voicemail-ringback-11s-v1.wav",
        audio_type: "wav",
        cache_audio: true,
        target_legs: "self",
        client_state: expect.any(String),
        command_id: expect.stringMatching(/^[a-f0-9]{64}$/),
      }
    );
    expect(mocks.speak).not.toHaveBeenCalled();
    const ringbackState = mocks.startPlayback.mock.calls[0][1]
      .client_state as string;
    const decodedRingbackState = JSON.parse(
      Buffer.from(ringbackState, "base64").toString()
    );
    expect(decodedRingbackState).toEqual({
      ...decodedInitiatedState,
      voicePhase: "pre_voicemail_ringback",
    });

    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.playback.ended",
        {
          call_control_id: "cc_forwarding_off",
          status: "completed",
          client_state: ringbackState,
        },
        "evt_voice_playback_ended_forwarding_off"
      )
    );

    const playbackResponse = await voiceWebhook(request());

    expect(playbackResponse.status).toBe(200);
    const expectedGreeting = buildSmsComplianceCopy({
      business: {
        name: "Test Biz",
        email: "owner@example.test",
        phone_number: "+15745550400",
      },
      smsPhoneNumber: "+15745550300",
      privacyUrl: "the business privacy policy",
      language: "en",
    }).voicemailGreeting;
    expect(mocks.speak).toHaveBeenCalledWith(
      "cc_forwarding_off",
      expect.objectContaining({
        payload: expectedGreeting,
        voice: "AWS.Polly.Joanna-Neural",
        language: "en-US",
        client_state: expect.any(String),
        command_id: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    const greetingState = mocks.speak.mock.calls[0][1].client_state as string;
    const decodedGreetingState = JSON.parse(
      Buffer.from(greetingState, "base64").toString()
    );
    expect(decodedGreetingState).toEqual({
      ...decodedRingbackState,
      voicePhase: "voicemail_greeting",
    });
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
      "phone_numbers",
      "businesses",
    ]);
  });

  it.each([
    {
      label: "English",
      language: "en" as Language | undefined,
      expectedVoice: "AWS.Polly.Joanna-Neural",
      expectedTtsLanguage: "en-US",
    },
    {
      label: "Spanish",
      language: "es" as Language | undefined,
      expectedVoice: "AWS.Polly.Lupe-Neural",
      expectedTtsLanguage: "es-US",
    },
    {
      label: "bilingual",
      language: "both" as Language | undefined,
      expectedVoice: "AWS.Polly.Joanna-Neural",
      expectedTtsLanguage: "en-US",
    },
    {
      label: "legacy state without a language",
      language: undefined,
      expectedVoice: "AWS.Polly.Joanna-Neural",
      expectedTtsLanguage: "en-US",
    },
  ])(
    "speaks the canonical $label voicemail after ringback with the matching Polly locale",
    async ({ language, expectedVoice, expectedTtsLanguage }) => {
      const state = encodeState({
        callControlId: "cc_locale",
        businessId: ATTEMPT.business_id,
        from: ATTEMPT.caller_phone,
        businessName: "Test Biz",
        businessEmail: "owner@example.test",
        businessPhoneNumber: "+15745550400",
        smsPhoneNumber: "+15745550300",
        voicePhase: "pre_voicemail_ringback",
        ...(language ? { language } : {}),
      });
      mocks.unwrap.mockResolvedValueOnce(
        voiceEvent(
          "call.playback.ended",
          {
            call_control_id: "cc_locale",
            status: "completed",
            client_state: state,
          },
          `evt_voice_playback_ended_${language ?? "missing_language"}`
        )
      );

      const response = await voiceWebhook(request());

      const expectedCopy = buildSmsComplianceCopy({
        business: {
          name: "Test Biz",
          email: "owner@example.test",
          phone_number: "+15745550400",
        },
        smsPhoneNumber: "+15745550300",
        privacyUrl: "the business privacy policy",
        language,
      });
      expect(response.status).toBe(200);
      expect(resolveComplianceCopyLocale(language)).toBe(
        language === "es" ? "es" : "en"
      );
      expect(mocks.speak).toHaveBeenCalledWith("cc_locale", {
        payload: expectedCopy.voicemailGreeting,
        voice: expectedVoice,
        language: expectedTtsLanguage,
        client_state: expect.any(String),
        command_id: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const greetingState = mocks.speak.mock.calls[0][1]
        .client_state as string;
      expect(
        JSON.parse(Buffer.from(greetingState, "base64").toString())
      ).toEqual(
        expect.objectContaining({ voicePhase: "voicemail_greeting" })
      );
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.dial).not.toHaveBeenCalled();
    }
  );

  it.each(["file_not_found", "failed", "unknown"])(
    "fails open to the voicemail disclosure when ringback ends with %s",
    async (status) => {
      const state = voicemailState({
        voicePhase: "pre_voicemail_ringback",
      });
      mocks.unwrap.mockResolvedValue(
        voiceEvent("call.playback.ended", {
          status,
          client_state: state,
        })
      );

      const response = await voiceWebhook(request());

      expect(response.status).toBe(200);
      expect(mocks.speak).toHaveBeenCalledOnce();
      expect(mocks.startRecording).not.toHaveBeenCalled();
      expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    }
  );

  it.each(["call_hangup", "cancelled", "cancelled_amd"])(
    "issues no further command when ringback ends with %s",
    async (status) => {
      const state = voicemailState({
        voicePhase: "pre_voicemail_ringback",
      });
      mocks.unwrap.mockResolvedValue(
        voiceEvent("call.playback.ended", {
          status,
          client_state: state,
        })
      );

      const response = await voiceWebhook(request());

      expect(response.status).toBe(200);
      expect(mocks.speak).not.toHaveBeenCalled();
      expect(mocks.startRecording).not.toHaveBeenCalled();
      expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      label: "missing client state",
      clientState: undefined,
    },
    {
      label: "malformed client state",
      clientState: "not-valid-base64-json",
    },
    {
      label: "missing phase",
      clientState: voicemailState(),
    },
    {
      label: "wrong phase",
      clientState: voicemailState({ voicePhase: "voicemail_greeting" }),
    },
  ])(
    "ignores ringback completion with $label",
    async ({ clientState }) => {
      mocks.unwrap.mockResolvedValue(
        voiceEvent("call.playback.ended", {
          status: "completed",
          ...(clientState ? { client_state: clientState } : {}),
        })
      );

      const response = await voiceWebhook(request());

      expect(response.status).toBe(200);
      expect(mocks.speak).not.toHaveBeenCalled();
      expect(mocks.startRecording).not.toHaveBeenCalled();
    }
  );

  it("fails open to the disclosure when the ringback command is rejected", async () => {
    const state = voicemailState();
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.answered", {
        call_control_id: "cc_voicemail",
        client_state: state,
      })
    );
    mocks.startPlayback.mockRejectedValue(new Error("playback unavailable"));

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.startPlayback).toHaveBeenCalledOnce();
    expect(mocks.speak).toHaveBeenCalledOnce();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("fails open to the disclosure when the public asset origin is unavailable", async () => {
    const state = voicemailState();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.answered", {
        call_control_id: "cc_voicemail",
        client_state: state,
      })
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.speak).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "network failure", httpStatus: undefined },
    { label: "request timeout", httpStatus: 408 },
    { label: "conflict", httpStatus: 409 },
    { label: "rate limit", httpStatus: 429 },
    { label: "provider failure", httpStatus: 503 },
  ])(
    "releases playback completion for retry after a disclosure $label",
    async ({ httpStatus }) => {
      const eventId = `evt_voice_playback_disclosure_retry_${httpStatus ?? "network"}`;
      const state = voicemailState({
        voicePhase: "pre_voicemail_ringback",
      });
      mocks.unwrap.mockResolvedValue(
        voiceEvent(
          "call.playback.ended",
          {
            status: "completed",
            client_state: state,
          },
          eventId
        )
      );
      mocks.speak.mockRejectedValue(
        Object.assign(
          new Error("speak unavailable"),
          httpStatus === undefined ? {} : { status: httpStatus }
        )
      );

      const response = await voiceWebhook(request());

      expect(response.status).toBe(500);
      expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(eventId);
      expect(mocks.startRecording).not.toHaveBeenCalled();
      expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    }
  );

  it.each([400, 401, 403, 404, 422])(
    "acknowledges terminal disclosure status %s without futile retries",
    async (httpStatus) => {
      const eventId = `evt_voice_playback_disclosure_terminal_${httpStatus}`;
      const state = voicemailState({
        voicePhase: "pre_voicemail_ringback",
      });
      mocks.unwrap.mockResolvedValue(
        voiceEvent(
          "call.playback.ended",
          {
            status: "completed",
            client_state: state,
          },
          eventId
        )
      );
      mocks.speak.mockRejectedValue(
        Object.assign(new Error("call is no longer actionable"), {
          status: httpStatus,
        })
      );

      const response = await voiceWebhook(request());

      expect(response.status).toBe(200);
      expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
      expect(mocks.startRecording).not.toHaveBeenCalled();
      expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    }
  );

  it("uses stable command IDs across semantically duplicate webhook events", async () => {
    const answeredState = voicemailState();
    mocks.unwrap
      .mockResolvedValueOnce(
        voiceEvent(
          "call.answered",
          {
            call_control_id: "cc_voicemail",
            client_state: answeredState,
          },
          "evt_voice_answered_duplicate_a"
        )
      )
      .mockResolvedValueOnce(
        voiceEvent(
          "call.answered",
          {
            call_control_id: "cc_voicemail",
            client_state: answeredState,
          },
          "evt_voice_answered_duplicate_b"
        )
      );

    await voiceWebhook(request());
    await voiceWebhook(request());

    const firstPlaybackCommand =
      mocks.startPlayback.mock.calls[0][1].command_id;
    const secondPlaybackCommand =
      mocks.startPlayback.mock.calls[1][1].command_id;
    expect(firstPlaybackCommand).toBe(secondPlaybackCommand);

    const ringbackState = mocks.startPlayback.mock.calls[0][1]
      .client_state as string;
    mocks.unwrap
      .mockResolvedValueOnce(
        voiceEvent(
          "call.playback.ended",
          {
            status: "completed",
            client_state: ringbackState,
          },
          "evt_voice_playback_duplicate_a"
        )
      )
      .mockResolvedValueOnce(
        voiceEvent(
          "call.playback.ended",
          {
            status: "completed",
            client_state: ringbackState,
          },
          "evt_voice_playback_duplicate_b"
        )
      );

    await voiceWebhook(request());
    await voiceWebhook(request());

    const firstGreetingCommand = mocks.speak.mock.calls[0][1].command_id;
    const secondGreetingCommand = mocks.speak.mock.calls[1][1].command_id;
    expect(firstGreetingCommand).toBe(secondGreetingCommand);
    expect(firstGreetingCommand).not.toBe(firstPlaybackCommand);
  });

  it("routes a forwarding attempt missing runtime session state through ringback", async () => {
    const state = voicemailState({
      callForwardingEnabled: true,
      forwardToNumber: ATTEMPT.forward_to_number,
      telnyxVoiceApplicationId: "voice_app_1",
    });
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.answered", {
        call_control_id: "cc_voicemail",
        client_state: state,
      })
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.startPlayback).toHaveBeenCalledOnce();
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
  });

  it("returns early for a forwarding target answer without marking connected", async () => {
    const state = voicemailState({
      forwardingRole: "forward_target",
      forwardingAttemptId: ATTEMPT.id,
    });
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.answered", {
        call_control_id: "cc_forward_target",
        client_state: state,
      })
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(mocks.startRecording).not.toHaveBeenCalled();
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "voicemail greeting phase",
      state: voicemailState({ voicePhase: "voicemail_greeting" }),
    },
    {
      label: "legacy phase-less state",
      state: voicemailState(),
    },
  ])(
    "starts recording after a completed disclosure with $label",
    async ({ state }) => {
      mocks.unwrap.mockResolvedValue(
        voiceEvent("call.speak.ended", {
          status: "completed",
          client_state: state,
        })
      );

      const response = await voiceWebhook(request());

      expect(response.status).toBe(200);
      expect(mocks.startRecording).toHaveBeenCalledWith("cc_voicemail", {
        channels: "single",
        format: "mp3",
        max_length: 60,
        timeout_secs: 5,
        play_beep: true,
        client_state: state,
      });
      expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    }
  );

  it("does not start recording from the ringback phase", async () => {
    const state = voicemailState({
      voicePhase: "pre_voicemail_ringback",
    });
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.speak.ended", {
        status: "completed",
        client_state: state,
      })
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.startRecording).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });

  it("preserves voicemail state through disclosure, recording, and missed-call SMS", async () => {
    const ringbackState = voicemailState({
      voicePhase: "pre_voicemail_ringback",
    });
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.playback.ended",
        {
          status: "completed",
          client_state: ringbackState,
        },
        "evt_voice_chain_playback"
      )
    );

    const playbackResponse = await voiceWebhook(request());

    expect(playbackResponse.status).toBe(200);
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    const greetingState = mocks.speak.mock.calls[0][1]
      .client_state as string;

    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.speak.ended",
        {
          status: "completed",
          client_state: greetingState,
        },
        "evt_voice_chain_speak"
      )
    );

    const speakResponse = await voiceWebhook(request());

    expect(speakResponse.status).toBe(200);
    expect(mocks.startRecording).toHaveBeenCalledOnce();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    const recordingState = mocks.startRecording.mock.calls[0][1]
      .client_state as string;

    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.recording.saved",
        {
          client_state: recordingState,
          call_session_id: "sess_voicemail",
          recording_urls: { mp3: "https://example.test/recording.mp3" },
        },
        "evt_voice_chain_recording"
      )
    );

    const recordingResponse = await voiceWebhook(request());

    expect(recordingResponse.status).toBe(200);
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
      ATTEMPT.caller_phone,
      ATTEMPT.business_id,
      "sess_voicemail"
    );
  });

  it("does not send SMS when the caller hangs up during ringback", async () => {
    const state = voicemailState({
      voicePhase: "pre_voicemail_ringback",
    });
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.hangup", {
        call_control_id: "cc_voicemail",
        call_session_id: "sess_voicemail",
        client_state: state,
        hangup_cause: "originator_cancel",
      })
    );
    queueResults(
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(mocks.startRecording).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });

  it("ignores stale forwarding client_state when live suspension requires voicemail and preserves the voicemail flow", async () => {
    const staleForwardingState = voicemailState({
      callControlId: "cc_suspended",
      callForwardingEnabled: true,
      forwardToNumber: ATTEMPT.forward_to_number,
      telnyxVoiceApplicationId: "voice_app_1",
    });
    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      SUSPENDED_OPERATIONAL_CONTROLS
    );
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: "cc_suspended",
          call_leg_id: "leg_suspended",
          call_session_id: "sess_suspended",
          client_state: staleForwardingState,
        },
        "evt_voice_suspended_before_dial"
      )
    );
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      {
        data: operationallyEndedAttempt("account_suspended_before_bridge", {
          outbound_call_control_id: null,
        }),
        error: null,
      }
    );

    const answeredResponse = await voiceWebhook(request());

    expect(answeredResponse.status).toBe(200);
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledWith(
      ATTEMPT.business_id
    );
    expect(mocks.startPlayback).toHaveBeenCalledWith(
      "cc_suspended",
      expect.objectContaining({ client_state: expect.any(String) })
    );
    expect(chains[1].in).toHaveBeenCalledWith("status", [
      "dialing",
      "connected",
    ]);
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();

    const ringbackState = mocks.startPlayback.mock.calls[0][1]
      .client_state as string;
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.playback.ended",
        { status: "completed", client_state: ringbackState },
        "evt_voice_suspended_playback_ended"
      )
    );

    const playbackResponse = await voiceWebhook(request());

    expect(playbackResponse.status).toBe(200);
    expect(mocks.speak).toHaveBeenCalledOnce();
    const greetingState = mocks.speak.mock.calls[0][1].client_state as string;

    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.speak.ended",
        { status: "completed", client_state: greetingState },
        "evt_voice_suspended_speak_ended"
      )
    );

    const speakResponse = await voiceWebhook(request());

    expect(speakResponse.status).toBe(200);
    expect(mocks.startRecording).toHaveBeenCalledWith(
      "cc_suspended",
      expect.objectContaining({ client_state: greetingState })
    );
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(1);
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });

  it.each([
    "aiRepliesPausedAt",
    "textingPausedAt",
    "bookingsPausedAt",
  ] as const)(
    "does not block voice forwarding for an independent %s pause",
    async (pausedField) => {
      mocks.resolveBusinessOperationalControls.mockResolvedValue({
        ...ACTIVE_OPERATIONAL_CONTROLS,
        [pausedField]: "2026-08-04T18:30:00Z",
      });
      mocks.unwrap.mockResolvedValue(
        voiceEvent(
          "call.answered",
          {
            call_control_id: ATTEMPT.inbound_call_control_id,
            call_leg_id: "leg_inbound",
            call_session_id: ATTEMPT.call_session_id,
            client_state: voicemailState({
              callControlId: ATTEMPT.inbound_call_control_id,
              callForwardingEnabled: true,
              forwardToNumber: ATTEMPT.forward_to_number,
              telnyxVoiceApplicationId: "voice_app_1",
            }),
          },
          `evt_voice_independent_${pausedField}`
        )
      );
      mocks.dial.mockResolvedValue({
        data: {
          call_control_id: ATTEMPT.outbound_call_control_id,
          call_leg_id: "leg_outbound",
        },
      });
      queueResults(
        {
          data: { ...ATTEMPT, outbound_call_control_id: null },
          error: null,
        },
        { error: null },
        { data: ATTEMPT, error: null },
        { data: ATTEMPT, error: null }
      );

      const response = await voiceWebhook(request());

      expect(response.status).toBe(200);
      expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(2);
      expect(mocks.dial).toHaveBeenCalledOnce();
      expect(mocks.bridge).toHaveBeenCalledOnce();
      expect(mocks.startPlayback).not.toHaveBeenCalled();
      expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    }
  );

  it("terminalizes the attempt before selecting voicemail at the final pre-dial check", async () => {
    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      SUSPENDED_OPERATIONAL_CONTROLS
    );
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_suspended_during_attempt_setup"
      )
    );
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      {
        data: operationallyEndedAttempt("account_suspended_before_bridge", {
          outbound_call_control_id: null,
        }),
        error: null,
      }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(1);
    expect(chains[1].update).toHaveBeenCalledWith({
      status: "ended",
      ended_at: expect.any(String),
      error_message: "account_suspended_before_bridge",
    });
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.startPlayback).toHaveBeenCalledOnce();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("cancels the owner leg and continues voicemail when suspension lands while dial is pending", async () => {
    const dial = deferred<{
      data: { call_control_id: string; call_leg_id: string };
    }>();
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_OPERATIONAL_CONTROLS)
      .mockResolvedValueOnce(SUSPENDED_OPERATIONAL_CONTROLS);
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_suspended_after_dial"
      )
    );
    mocks.dial.mockReturnValue(dial.promise);
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      { error: null },
      { data: { ...ATTEMPT, status: "connected" }, error: null },
      {
        data: operationallyEndedAttempt("account_suspended_before_bridge"),
        error: null,
      }
    );

    const responsePromise = voiceWebhook(request());
    await vi.waitFor(() => expect(mocks.dial).toHaveBeenCalledOnce());
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(1);

    dial.resolve({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(2);
    expect(chains[3].update).toHaveBeenCalledWith({
      status: "ended",
      ended_at: expect.any(String),
      error_message: "account_suspended_before_bridge",
    });
    expect(chains[3].eq).toHaveBeenNthCalledWith(1, "id", ATTEMPT.id);
    expect(chains[3].in).toHaveBeenCalledWith("status", [
      "dialing",
      "connected",
    ]);
    expect(chains[3].is).toHaveBeenCalledWith("fallback_triggered_at", null);
    expect(mocks.hangup).toHaveBeenCalledWith(
      ATTEMPT.outbound_call_control_id,
      {}
    );
    expect(mocks.hangup).toHaveBeenCalledTimes(1);
    expect(mocks.startPlayback).toHaveBeenCalledWith(
      ATTEMPT.inbound_call_control_id,
      expect.objectContaining({ client_state: expect.any(String) })
    );
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("ignores the owner hangup emitted by suspended-forwarding cleanup", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.hangup",
        {
          call_control_id: ATTEMPT.outbound_call_control_id,
          call_session_id: ATTEMPT.call_session_id,
          client_state: encodeState({
            callControlId: ATTEMPT.inbound_call_control_id,
            businessId: ATTEMPT.business_id,
            from: ATTEMPT.caller_phone,
            businessName: "Test Biz",
            forwardingRole: "forward_target",
            forwardingAttemptId: ATTEMPT.id,
          }),
          hangup_cause: "normal_clearing",
        },
        "evt_voice_suspended_owner_cleanup_hangup"
      )
    );
    queueResults({ data: { ...ATTEMPT, status: "ended" }, error: null });

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("releases and retries when operational state is unavailable before owner dial", async () => {
    mocks.resolveBusinessOperationalControls.mockRejectedValue(
      new Error("operational state unavailable")
    );
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_operational_state_unavailable_before_dial"
      )
    );
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      {
        data: operationallyEndedAttempt(
          "operational_state_unavailable_before_bridge",
          { outbound_call_control_id: null }
        ),
        error: null,
      }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_operational_state_unavailable_before_dial"
    );
    expect(chains).toHaveLength(2);
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });

  it("cleans the owner leg and retries without fallback when the post-dial state read is unavailable", async () => {
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_OPERATIONAL_CONTROLS)
      .mockRejectedValueOnce(new Error("operational state unavailable"));
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_operational_state_unavailable_after_dial"
      )
    );
    mocks.dial.mockResolvedValue({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      { error: null },
      { data: ATTEMPT, error: null },
      {
        data: operationallyEndedAttempt(
          "operational_state_unavailable_before_bridge"
        ),
        error: null,
      }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(chains[3].update).toHaveBeenCalledWith({
      status: "ended",
      ended_at: expect.any(String),
      error_message: "operational_state_unavailable_before_bridge",
    });
    expect(chains[3].in).toHaveBeenCalledWith("status", [
      "dialing",
      "connected",
    ]);
    expect(mocks.hangup).toHaveBeenCalledWith(
      ATTEMPT.outbound_call_control_id,
      {}
    );
    expect(chains[3].update.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.hangup.mock.invocationCallOrder[0]
    );
    expect(mocks.hangup).toHaveBeenCalledTimes(1);
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_operational_state_unavailable_after_dial"
    );
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(chains).toHaveLength(4);
  });

  it("retries persisted owner cleanup on redelivery and preserves voicemail without a second dial", async () => {
    const stoppedAttempt = operationallyEndedAttempt(
      "operational_state_unavailable_before_bridge"
    );
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_operational_cleanup_redelivery"
      )
    );
    mocks.hangup.mockRejectedValue(
      Object.assign(new Error("call already ended"), { status: 422 })
    );
    queueResults(
      { data: null, error: { code: "23505", message: "duplicate session" } },
      { data: stoppedAttempt, error: null }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.hangup).toHaveBeenCalledWith(
      ATTEMPT.outbound_call_control_id,
      {}
    );
    expect(mocks.startPlayback).toHaveBeenCalledWith(
      ATTEMPT.inbound_call_control_id,
      expect.objectContaining({ client_state: expect.any(String) })
    );
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
    expect(chains).toHaveLength(2);
    expect(chains.every((chain) => chain.update.mock.calls.length === 0)).toBe(
      true
    );
  });

  it("uses the final attempt fence when a distinct delivery terminalizes after the original operational read", async () => {
    const finalAttemptRead = deferred<{
      data: Record<string, unknown>;
      error: null;
    }>();
    const forwardingState = voicemailState({
      callControlId: ATTEMPT.inbound_call_control_id,
      callForwardingEnabled: true,
      forwardToNumber: ATTEMPT.forward_to_number,
      telnyxVoiceApplicationId: "voice_app_1",
    });
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: forwardingState,
        },
        "evt_voice_original_before_final_fence"
      )
    );
    mocks.dial.mockResolvedValue({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      { error: null },
      { data: ATTEMPT, error: null },
      finalAttemptRead.promise,
      { data: null, error: { code: "23505", message: "duplicate session" } },
      { data: ATTEMPT, error: null },
      {
        data: operationallyEndedAttempt(
          "operational_state_unavailable_before_bridge"
        ),
        error: null,
      }
    );

    const originalResponsePromise = voiceWebhook(request());
    await vi.waitFor(() => expect(chains).toHaveLength(4));
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(2);
    expect(mocks.bridge).not.toHaveBeenCalled();

    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: forwardingState,
        },
        "evt_voice_duplicate_terminalizes_attempt"
      )
    );

    const duplicateResponse = await voiceWebhook(request());

    expect(duplicateResponse.status).toBe(500);
    expect(chains[6].update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ended",
        error_message: "operational_state_unavailable_before_bridge",
      })
    );
    expect(mocks.hangup).toHaveBeenCalledTimes(1);
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();

    finalAttemptRead.resolve({
      data: operationallyEndedAttempt(
        "operational_state_unavailable_before_bridge"
      ),
      error: null,
    });
    const originalResponse = await originalResponsePromise;

    expect(originalResponse.status).toBe(200);
    expect(mocks.dial).toHaveBeenCalledTimes(1);
    expect(mocks.hangup).toHaveBeenCalledTimes(2);
    expect(mocks.startPlayback).toHaveBeenCalledTimes(1);
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_duplicate_terminalizes_attempt"
    );
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalledWith(
      "evt_voice_original_before_final_fence"
    );
  });

  it("cleans the owner leg without bridging when fallback wins at the final attempt fence", async () => {
    const forwardingState = voicemailState({
      callControlId: ATTEMPT.inbound_call_control_id,
      callForwardingEnabled: true,
      forwardToNumber: ATTEMPT.forward_to_number,
      telnyxVoiceApplicationId: "voice_app_1",
    });
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: forwardingState,
        },
        "evt_voice_fallback_wins_final_fence"
      )
    );
    mocks.dial.mockResolvedValue({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      { error: null },
      { data: ATTEMPT, error: null },
      {
        data: {
          ...ATTEMPT,
          status: "fallback_triggered",
          fallback_triggered_at: "2026-08-04T18:55:00Z",
        },
        error: null,
      }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.hangup).toHaveBeenCalledWith(
      ATTEMPT.outbound_call_control_id,
      {}
    );
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("releases a suspended post-dial event when owner cleanup fails retryably", async () => {
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_OPERATIONAL_CONTROLS)
      .mockResolvedValueOnce(SUSPENDED_OPERATIONAL_CONTROLS);
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_suspended_cleanup_retry"
      )
    );
    mocks.dial.mockResolvedValue({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    mocks.hangup.mockRejectedValue(
      Object.assign(new Error("Telnyx unavailable"), { status: 503 })
    );
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      { error: null },
      { data: ATTEMPT, error: null },
      {
        data: operationallyEndedAttempt("account_suspended_before_bridge"),
        error: null,
      }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(chains[3].update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ended",
        error_message: "account_suspended_before_bridge",
      })
    );
    expect(chains[3].update.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.hangup.mock.invocationCallOrder[0]
    );
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_suspended_cleanup_retry"
    );
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });

  it("lets an interleaved suspended owner hangup terminalize first while both deliveries preserve voicemail", async () => {
    const postDialControls = deferred<typeof SUSPENDED_OPERATIONAL_CONTROLS>();
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_OPERATIONAL_CONTROLS)
      .mockReturnValueOnce(postDialControls.promise)
      .mockResolvedValueOnce(SUSPENDED_OPERATIONAL_CONTROLS);
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_original_waiting_on_suspension"
      )
    );
    mocks.dial.mockResolvedValue({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      { error: null },
      { data: ATTEMPT, error: null },
      { data: { ...ATTEMPT, status: "connected" }, error: null },
      {
        data: operationallyEndedAttempt("account_suspended_before_bridge"),
        error: null,
      },
      { data: null, error: null },
      {
        data: operationallyEndedAttempt("account_suspended_before_bridge"),
        error: null,
      }
    );

    const originalResponsePromise = voiceWebhook(request());
    await vi.waitFor(() =>
      expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(2)
    );
    expect(chains).toHaveLength(3);
    expect(mocks.bridge).not.toHaveBeenCalled();

    const outboundState = mocks.dial.mock.calls[0][0].client_state as string;
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.hangup",
        {
          call_control_id: ATTEMPT.outbound_call_control_id,
          call_session_id: ATTEMPT.call_session_id,
          client_state: outboundState,
          hangup_cause: "timeout",
        },
        "evt_voice_owner_hangup_observes_suspension"
      )
    );

    const ownerHangupResponse = await voiceWebhook(request());

    expect(ownerHangupResponse.status).toBe(200);
    expect(chains[4].update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ended",
        error_message: "account_suspended_before_bridge",
      })
    );
    expect(chains[4].in).toHaveBeenCalledWith("status", [
      "dialing",
      "connected",
    ]);
    expect(mocks.startPlayback).toHaveBeenCalledTimes(1);
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();

    postDialControls.resolve(SUSPENDED_OPERATIONAL_CONTROLS);
    const originalResponse = await originalResponsePromise;

    expect(originalResponse.status).toBe(200);
    expect(chains[5].in).toHaveBeenCalledWith("status", [
      "dialing",
      "connected",
    ]);
    expect(mocks.hangup).toHaveBeenCalledTimes(1);
    expect(mocks.hangup).toHaveBeenCalledWith(
      ATTEMPT.outbound_call_control_id,
      {}
    );
    expect(mocks.hangup).not.toHaveBeenCalledWith(
      ATTEMPT.inbound_call_control_id,
      {}
    );
    expect(mocks.startPlayback).toHaveBeenCalledTimes(2);
    expect(mocks.startPlayback.mock.calls[0][1].command_id).toBe(
      mocks.startPlayback.mock.calls[1][1].command_id
    );
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("retries an owner hangup without claiming fallback when operational state is unavailable", async () => {
    mocks.resolveBusinessOperationalControls.mockRejectedValue(
      new Error("operational state unavailable")
    );
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.hangup",
        {
          call_control_id: ATTEMPT.outbound_call_control_id,
          call_session_id: ATTEMPT.call_session_id,
          client_state: encodeState({
            callControlId: ATTEMPT.inbound_call_control_id,
            businessId: ATTEMPT.business_id,
            from: ATTEMPT.caller_phone,
            businessName: "Test Biz",
            forwardingRole: "forward_target",
            forwardingAttemptId: ATTEMPT.id,
          }),
          hangup_cause: "timeout",
        },
        "evt_voice_owner_hangup_state_unavailable"
      )
    );
    queueResults({ data: ATTEMPT, error: null });

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_owner_hangup_state_unavailable"
    );
    expect(chains).toHaveLength(1);
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });

  it("uses safe attempt data to preserve voicemail for a suspended owner hangup without client_state", async () => {
    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      SUSPENDED_OPERATIONAL_CONTROLS
    );
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.hangup",
        {
          call_control_id: ATTEMPT.outbound_call_control_id,
          call_session_id: ATTEMPT.call_session_id,
          hangup_cause: "timeout",
        },
        "evt_voice_owner_hangup_missing_state"
      )
    );
    queueResults(
      { data: null, error: null },
      { data: ATTEMPT, error: null },
      {
        data: operationallyEndedAttempt("account_suspended_before_bridge"),
        error: null,
      }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.startPlayback).toHaveBeenCalledWith(
      ATTEMPT.inbound_call_control_id,
      expect.objectContaining({ client_state: expect.any(String) })
    );
    const voicemailClientState = mocks.startPlayback.mock.calls[0][1]
      .client_state as string;
    expect(
      JSON.parse(Buffer.from(voicemailClientState, "base64").toString())
    ).toEqual(
      expect.objectContaining({
        callControlId: ATTEMPT.inbound_call_control_id,
        businessId: ATTEMPT.business_id,
        from: ATTEMPT.caller_phone,
        businessName: "us",
        voicePhase: "pre_voicemail_ringback",
      })
    );
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("fails retryably when a zero-row operational CAS still reads connected", async () => {
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_OPERATIONAL_CONTROLS)
      .mockResolvedValueOnce(SUSPENDED_OPERATIONAL_CONTROLS);
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_suspension_connected_cas_race"
      )
    );
    mocks.dial.mockResolvedValue({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      { error: null },
      { data: ATTEMPT, error: null },
      { data: null, error: null },
      { data: { ...ATTEMPT, status: "connected" }, error: null }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_suspension_connected_cas_race"
    );
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });

  it("prevents a stale hangup handler from overwriting an ended operational attempt with fallback", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.hangup",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          client_state: HANGUP_STATE,
          hangup_cause: "originator_cancel",
        },
        "evt_voice_stale_hangup_after_operational_end"
      )
    );
    queueResults(
      { data: ATTEMPT, error: null },
      { data: null, error: null }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(chains[1].in).toHaveBeenCalledWith("status", ["dialing", "error"]);
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("retries instead of acknowledging a forwarding-attempt creation failure", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_attempt_create_failure"
      )
    );
    queueResults({
      data: null,
      error: { code: "08006", message: "database unavailable" },
    });

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_attempt_create_failure"
    );
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
  });

  it("retries when a duplicate forwarding attempt cannot be recovered", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: voicemailState({
            callControlId: ATTEMPT.inbound_call_control_id,
            callForwardingEnabled: true,
            forwardToNumber: ATTEMPT.forward_to_number,
            telnyxVoiceApplicationId: "voice_app_1",
          }),
        },
        "evt_voice_attempt_recovery_failure"
      )
    );
    queueResults(
      { data: null, error: { code: "23505", message: "duplicate session" } },
      { data: null, error: { message: "database unavailable" } }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_attempt_recovery_failure"
    );
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
  });

  it("uses forwarding-enabled configuration captured at initiation to create, dial, and bridge an attempt", async () => {
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.initiated",
        {
          direction: "incoming",
          from: ATTEMPT.caller_phone,
          to: "+15745550300",
          call_control_id: "cc_inbound",
        },
        "evt_voice_initiated_forwarding_on"
      )
    );
    queueResults(
      { data: { business_id: ATTEMPT.business_id }, error: null },
      {
        data: {
          name: "Test Biz",
          email: "owner@example.test",
          phone_number: "+15745550400",
          telnyx_voice_application_id: "voice_app_1",
          call_forwarding_enabled: true,
          forward_to_number: ATTEMPT.forward_to_number,
          ai_settings: [{ language: "es" }],
        },
        error: null,
      }
    );

    const initiatedResponse = await voiceWebhook(request());

    expect(initiatedResponse.status).toBe(200);
    const initiatedState = mocks.answer.mock.calls[0][1]
      .client_state as string;
    expect(
      JSON.parse(Buffer.from(initiatedState, "base64").toString())
    ).toEqual(
      expect.objectContaining({
        telnyxVoiceApplicationId: "voice_app_1",
        smsPhoneNumber: "+15745550300",
        language: "es",
        callForwardingEnabled: true,
        forwardToNumber: ATTEMPT.forward_to_number,
      })
    );

    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: "cc_inbound",
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: initiatedState,
        },
        "evt_voice_answered_forwarding_on"
      )
    );
    mocks.dial.mockResolvedValue({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      }, // createForwardingAttempt
      { error: null }, // updateForwardingAttemptOutbound
      { data: ATTEMPT, error: null }, // pre-bridge fallback check
      { data: ATTEMPT, error: null } // attempt remains dialing until call.bridged
    );

    const answeredResponse = await voiceWebhook(request());

    expect(answeredResponse.status).toBe(200);
    expect(chains[0].insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: ATTEMPT.business_id,
        inbound_call_control_id: "cc_inbound",
        inbound_call_leg_id: "leg_inbound",
        call_session_id: ATTEMPT.call_session_id,
        caller_phone: ATTEMPT.caller_phone,
        forward_to_number: ATTEMPT.forward_to_number,
        status: "dialing",
      })
    );
    expect(mocks.dial).toHaveBeenCalledWith({
      connection_id: "voice_app_1",
      from: "+15745550300",
      to: ATTEMPT.forward_to_number,
      timeout_secs: 18,
      client_state: expect.any(String),
    });
    expect(chains[1].update).toHaveBeenCalledWith({
      outbound_call_control_id: ATTEMPT.outbound_call_control_id,
      outbound_call_leg_id: "leg_outbound",
    });
    expect(mocks.bridge).toHaveBeenCalledWith("cc_inbound", {
      call_control_id_to_bridge_with: ATTEMPT.outbound_call_control_id,
      play_ringtone: true,
      prevent_double_bridge: true,
      client_state: expect.any(String),
    });

    const outboundState = mocks.dial.mock.calls[0][0].client_state as string;
    expect(
      JSON.parse(Buffer.from(outboundState, "base64").toString())
    ).toEqual(
      expect.objectContaining({
        forwardingRole: "forward_target",
        forwardingAttemptId: ATTEMPT.id,
        language: "es",
      })
    );
    const inboundState = mocks.bridge.mock.calls[0][1]
      .client_state as string;
    expect(
      JSON.parse(Buffer.from(inboundState, "base64").toString())
    ).toEqual(
      expect.objectContaining({
        forwardingRole: "inbound",
        forwardingAttemptId: ATTEMPT.id,
        outboundCallControlId: ATTEMPT.outbound_call_control_id,
        language: "es",
      })
    );
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
      "phone_numbers",
      "businesses",
      "call_forwarding_attempts",
      "call_forwarding_attempts",
      "call_forwarding_attempts",
      "call_forwarding_attempts",
    ]);
  });

  it.each([
    {
      failure: "the dial command rejects",
      behavior: "rejects" as const,
      reason: "dial unavailable",
    },
    {
      failure: "the dial response has no outbound ID",
      behavior: "missing_id" as const,
      reason: "Telnyx dial returned no outbound call_control_id",
    },
  ])(
    "sends one missed-call SMS when owner dialing fails with $failure",
    async ({ behavior, reason }) => {
      mocks.unwrap.mockResolvedValue(
        voiceEvent(
          "call.answered",
          {
            call_control_id: ATTEMPT.inbound_call_control_id,
            call_leg_id: "leg_inbound",
            call_session_id: ATTEMPT.call_session_id,
            client_state: forwardingInboundState(),
          },
          `evt_voice_dial_failure_${behavior}`
        )
      );
      if (behavior === "rejects") {
        mocks.dial.mockRejectedValueOnce(new Error(reason));
      } else {
        mocks.dial.mockResolvedValueOnce({
          data: { call_leg_id: "leg_outbound" },
        });
      }
      queueResults(
        {
          data: { ...ATTEMPT, outbound_call_control_id: null },
          error: null,
        },
        {
          data: {
            ...ATTEMPT,
            outbound_call_control_id: null,
            status: "error",
            fallback_triggered_at: "2026-08-11T12:00:00.000Z",
            error_message: reason,
          },
          error: null,
        }
      );

      const response = await voiceWebhook(request());

      expect(response.status).toBe(200);
      expect(chains).toHaveLength(2);
      expect(chains[1].update).toHaveBeenCalledWith({
        status: "error",
        fallback_triggered_at: expect.any(String),
        error_message: reason,
      });
      expect(chains[1].is).toHaveBeenCalledWith(
        "fallback_triggered_at",
        null
      );
      expect(chains[1].in).toHaveBeenCalledWith("status", [
        "dialing",
        "error",
      ]);
      expect(mocks.bridge).not.toHaveBeenCalled();
      expect(mocks.hangup).toHaveBeenCalledOnce();
      expect(mocks.hangup).toHaveBeenCalledWith(
        ATTEMPT.inbound_call_control_id,
        {}
      );
      expect(mocks.sendMissedCallSMS).toHaveBeenCalledOnce();
      expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
        ATTEMPT.caller_phone,
        ATTEMPT.business_id,
        ATTEMPT.call_session_id
      );
      expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
    }
  );

  it("sends one missed-call SMS when owner answer arrives before a rejected bridge", async () => {
    const bridgeGate = deferred<void>();
    mocks.bridge.mockImplementationOnce(async () => {
      await bridgeGate.promise;
      throw new Error("bridge rejected");
    });
    mocks.dial.mockResolvedValueOnce({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: forwardingInboundState(),
        },
        "evt_voice_bridge_rejected_inbound_answer"
      )
    );
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      { error: null },
      { data: ATTEMPT, error: null },
      { data: ATTEMPT, error: null },
      {
        data: {
          ...ATTEMPT,
          status: "error",
          fallback_triggered_at: "2026-08-11T12:00:00.000Z",
          error_message: "bridge rejected",
        },
        error: null,
      }
    );

    const inboundResponsePromise = voiceWebhook(request());
    await vi.waitFor(() => expect(mocks.bridge).toHaveBeenCalledOnce());

    const ownerState = mocks.dial.mock.calls[0][0].client_state as string;
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.outbound_call_control_id,
          client_state: ownerState,
        },
        "evt_voice_bridge_rejected_owner_answer"
      )
    );
    const ownerResponse = await voiceWebhook(request());

    bridgeGate.resolve(undefined);
    const inboundResponse = await inboundResponsePromise;

    expect(ownerResponse.status).toBe(200);
    expect(inboundResponse.status).toBe(200);
    expect(chains).toHaveLength(5);
    expect(chains[4].update).toHaveBeenCalledWith({
      status: "error",
      fallback_triggered_at: expect.any(String),
      error_message: "bridge rejected",
    });
    expect(chains[4].is).toHaveBeenCalledWith("fallback_triggered_at", null);
    expect(chains[4].in).toHaveBeenCalledWith("status", ["dialing", "error"]);
    for (const chain of chains) {
      expect(chain.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "connected" })
      );
    }
    expect(mocks.hangup).toHaveBeenCalledTimes(2);
    expect(mocks.hangup).toHaveBeenNthCalledWith(
      1,
      ATTEMPT.outbound_call_control_id,
      {}
    );
    expect(mocks.hangup).toHaveBeenNthCalledWith(
      2,
      ATTEMPT.inbound_call_control_id,
      {}
    );
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledOnce();
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
      ATTEMPT.caller_phone,
      ATTEMPT.business_id,
      ATTEMPT.call_session_id
    );
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it.each([
    { cause: "user_busy" },
    { cause: "timeout" },
    { cause: "network_congestion" },
  ])(
    "sends one missed-call SMS when an unbridged owner leg ends with $cause",
    async ({ cause }) => {
      const targetState = forwardTargetState();
      mocks.unwrap.mockResolvedValue(
        voiceEvent(
          "call.hangup",
          {
            call_control_id: ATTEMPT.outbound_call_control_id,
            client_state: targetState,
            hangup_cause: cause,
          },
          `evt_voice_owner_hangup_${cause}`
        )
      );
      queueResults(
        { data: ATTEMPT, error: null },
        {
          data: {
            ...ATTEMPT,
            status: "fallback_triggered",
            fallback_triggered_at: "2026-08-11T12:00:00.000Z",
            error_message: `owner_hangup_before_bridge:${cause}`,
          },
          error: null,
        }
      );

      const response = await voiceWebhook(request());

      expect(response.status).toBe(200);
      expect(chains).toHaveLength(2);
      expect(chains[1].update).toHaveBeenCalledWith({
        status: "fallback_triggered",
        fallback_triggered_at: expect.any(String),
        error_message: `owner_hangup_before_bridge:${cause}`,
      });
      expect(chains[1].is).toHaveBeenCalledWith(
        "fallback_triggered_at",
        null
      );
      expect(chains[1].in).toHaveBeenCalledWith("status", [
        "dialing",
        "error",
      ]);
      expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledOnce();
      expect(mocks.hangup).toHaveBeenCalledOnce();
      expect(mocks.hangup).toHaveBeenCalledWith(
        ATTEMPT.inbound_call_control_id,
        {}
      );
      expect(mocks.sendMissedCallSMS).toHaveBeenCalledOnce();
      expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
        ATTEMPT.caller_phone,
        ATTEMPT.business_id,
        ATTEMPT.call_session_id
      );
      expect(mocks.dial).not.toHaveBeenCalled();
      expect(mocks.bridge).not.toHaveBeenCalled();
    }
  );

  it("sends one fallback SMS when the caller abandons while the owner rings", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.hangup", {
        call_control_id: "cc_inbound",
        client_state: HANGUP_STATE,
        hangup_cause: "originator_cancel",
      })
    );
    queueResults(
      { data: ATTEMPT, error: null }, // getForwardingAttemptById
      {
        data: {
          ...ATTEMPT,
          status: "abandoned",
          fallback_triggered_at: "2026-08-11T12:00:00.000Z",
        },
        error: null,
      } // fallback claim
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(chains[1].update).toHaveBeenCalledWith({
      status: "abandoned",
      fallback_triggered_at: expect.any(String),
      abandoned_at: expect.any(String),
      error_message: "caller_hangup_before_bridge:originator_cancel",
    });
    expect(chains[1].eq).toHaveBeenCalledWith("id", ATTEMPT.id);
    expect(chains[1].is).toHaveBeenCalledWith("fallback_triggered_at", null);
    expect(chains[1].in).toHaveBeenCalledWith("status", ["dialing", "error"]);
    expect(mocks.hangup).toHaveBeenCalledOnce();
    expect(mocks.hangup).toHaveBeenCalledWith(
      ATTEMPT.outbound_call_control_id,
      {}
    );
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledOnce();
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
      ATTEMPT.caller_phone,
      ATTEMPT.business_id,
      ATTEMPT.call_session_id
    );
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      leg: "inbound",
      callControlId: ATTEMPT.inbound_call_control_id,
      cause: "originator_cancel",
      status: "abandoned",
      reason: "caller_hangup_before_bridge:originator_cancel",
      cleanupCallControlId: ATTEMPT.outbound_call_control_id,
    },
    {
      leg: "outbound",
      callControlId: ATTEMPT.outbound_call_control_id,
      cause: "user_busy",
      status: "fallback_triggered",
      reason: "owner_hangup_before_bridge:user_busy",
      cleanupCallControlId: ATTEMPT.inbound_call_control_id,
    },
  ])(
    "sends one missed-call SMS when the $leg leg dies after bridge acceptance but before call.bridged",
    async ({
      leg,
      callControlId,
      cause,
      status,
      reason,
      cleanupCallControlId,
    }) => {
      mocks.dial.mockResolvedValueOnce({
        data: {
          call_control_id: ATTEMPT.outbound_call_control_id,
          call_leg_id: "leg_outbound",
        },
      });
      mocks.unwrap.mockResolvedValueOnce(
        voiceEvent(
          "call.answered",
          {
            call_control_id: ATTEMPT.inbound_call_control_id,
            call_leg_id: "leg_inbound",
            call_session_id: ATTEMPT.call_session_id,
            client_state: forwardingInboundState(),
          },
          `evt_voice_bridge_accepted_${leg}`
        )
      );
      const claimedAttempt = {
        ...ATTEMPT,
        status,
        fallback_triggered_at: "2026-08-11T12:00:00.000Z",
        error_message: reason,
        ...(status === "abandoned"
          ? { abandoned_at: "2026-08-11T12:00:00.000Z" }
          : {}),
      };
      queueResults(
        {
          data: { ...ATTEMPT, outbound_call_control_id: null },
          error: null,
        },
        { error: null },
        { data: ATTEMPT, error: null },
        { data: ATTEMPT, error: null },
        { data: ATTEMPT, error: null },
        { data: claimedAttempt, error: null }
      );

      const answeredResponse = await voiceWebhook(request());

      expect(answeredResponse.status).toBe(200);
      expect(mocks.bridge).toHaveBeenCalledOnce();
      expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
      const hangupState =
        leg === "inbound"
          ? (mocks.bridge.mock.calls[0][1].client_state as string)
          : (mocks.dial.mock.calls[0][0].client_state as string);
      mocks.unwrap.mockResolvedValueOnce(
        voiceEvent(
          "call.hangup",
          {
            call_control_id: callControlId,
            client_state: hangupState,
            hangup_cause: cause,
          },
          `evt_voice_pre_bridged_${leg}_hangup`
        )
      );

      const hangupResponse = await voiceWebhook(request());

      expect(hangupResponse.status).toBe(200);
      expect(chains).toHaveLength(6);
      expect(chains[5].update).toHaveBeenCalledWith({
        status,
        fallback_triggered_at: expect.any(String),
        error_message: reason,
        ...(status === "abandoned"
          ? { abandoned_at: expect.any(String) }
          : {}),
      });
      expect(chains[5].is).toHaveBeenCalledWith(
        "fallback_triggered_at",
        null
      );
      expect(chains[5].in).toHaveBeenCalledWith("status", [
        "dialing",
        "error",
      ]);
      for (const chain of chains) {
        expect(chain.update).not.toHaveBeenCalledWith(
          expect.objectContaining({ status: "connected" })
        );
      }
      expect(mocks.hangup).toHaveBeenCalledOnce();
      expect(mocks.hangup).toHaveBeenCalledWith(cleanupCallControlId, {});
      expect(mocks.sendMissedCallSMS).toHaveBeenCalledOnce();
      expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
        ATTEMPT.caller_phone,
        ATTEMPT.business_id,
        ATTEMPT.call_session_id
      );
      expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
    }
  );

  it("rescues a dial-failure fallback-claim error from a later inbound hangup", async () => {
    const answeredEvent = voiceEvent(
      "call.answered",
      {
        call_control_id: ATTEMPT.inbound_call_control_id,
        call_leg_id: "leg_inbound",
        call_session_id: ATTEMPT.call_session_id,
        client_state: forwardingInboundState(),
      },
      "evt_voice_dial_claim_error"
    );
    const hangupEvent = voiceEvent(
      "call.hangup",
      {
        call_control_id: ATTEMPT.inbound_call_control_id,
        client_state: HANGUP_STATE,
        hangup_cause: "originator_cancel",
      },
      "evt_voice_dial_claim_error_inbound_hangup"
    );
    mocks.unwrap
      .mockResolvedValueOnce(answeredEvent)
      .mockResolvedValueOnce(hangupEvent);
    mocks.dial.mockRejectedValueOnce(new Error("dial unavailable"));
    const dialingAttemptWithoutOwner = {
      ...ATTEMPT,
      outbound_call_control_id: null,
      status: "dialing",
      fallback_triggered_at: null,
    };
    queueResults(
      { data: dialingAttemptWithoutOwner, error: null },
      { data: null, error: { message: "connection reset" } },
      { data: dialingAttemptWithoutOwner, error: null },
      {
        data: {
          ...dialingAttemptWithoutOwner,
          status: "abandoned",
          fallback_triggered_at: "2026-08-11T12:00:00.000Z",
          abandoned_at: "2026-08-11T12:00:00.000Z",
          error_message: "caller_hangup_before_bridge:originator_cancel",
        },
        error: null,
      }
    );

    const answeredResponse = await voiceWebhook(request());

    expect(answeredResponse.status).toBe(200);
    expect(chains).toHaveLength(2);
    expect(chains[1].update).toHaveBeenCalledWith({
      status: "error",
      fallback_triggered_at: expect.any(String),
      error_message: "dial unavailable",
    });
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();

    const hangupResponse = await voiceWebhook(request());

    expect(hangupResponse.status).toBe(200);
    expect(chains).toHaveLength(4);
    expect(chains[3].update).toHaveBeenCalledWith({
      status: "abandoned",
      fallback_triggered_at: expect.any(String),
      abandoned_at: expect.any(String),
      error_message: "caller_hangup_before_bridge:originator_cancel",
    });
    expect(chains[3].is).toHaveBeenCalledWith(
      "fallback_triggered_at",
      null
    );
    expect(chains[3].in).toHaveBeenCalledWith("status", [
      "dialing",
      "error",
    ]);
    expect(
      chains.filter((chain) => chain.insert.mock.calls.length > 0)
    ).toHaveLength(1);
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledOnce();
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
      ATTEMPT.caller_phone,
      ATTEMPT.business_id,
      ATTEMPT.call_session_id
    );
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("rescues a bridge-failure fallback-claim error from a later outbound hangup", async () => {
    mocks.dial.mockResolvedValueOnce({
      data: {
        call_control_id: ATTEMPT.outbound_call_control_id,
        call_leg_id: "leg_outbound",
      },
    });
    mocks.bridge.mockRejectedValueOnce(new Error("bridge rejected"));
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.inbound_call_control_id,
          call_leg_id: "leg_inbound",
          call_session_id: ATTEMPT.call_session_id,
          client_state: forwardingInboundState(),
        },
        "evt_voice_bridge_claim_error"
      )
    );
    queueResults(
      {
        data: { ...ATTEMPT, outbound_call_control_id: null },
        error: null,
      },
      { error: null },
      { data: ATTEMPT, error: null },
      { data: ATTEMPT, error: null },
      { data: null, error: { message: "connection reset" } },
      { data: ATTEMPT, error: null },
      {
        data: {
          ...ATTEMPT,
          status: "fallback_triggered",
          fallback_triggered_at: "2026-08-11T12:00:00.000Z",
          error_message: "owner_hangup_before_bridge:user_busy",
        },
        error: null,
      }
    );

    const answeredResponse = await voiceWebhook(request());

    expect(answeredResponse.status).toBe(200);
    expect(chains).toHaveLength(5);
    expect(chains[4].update).toHaveBeenCalledWith({
      status: "error",
      fallback_triggered_at: expect.any(String),
      error_message: "bridge rejected",
    });
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();

    const targetState = mocks.dial.mock.calls[0][0].client_state as string;
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.hangup",
        {
          call_control_id: ATTEMPT.outbound_call_control_id,
          client_state: targetState,
          hangup_cause: "user_busy",
        },
        "evt_voice_bridge_claim_error_outbound_hangup"
      )
    );
    const hangupResponse = await voiceWebhook(request());

    expect(hangupResponse.status).toBe(200);
    expect(chains).toHaveLength(7);
    expect(chains[6].update).toHaveBeenCalledWith({
      status: "fallback_triggered",
      fallback_triggered_at: expect.any(String),
      error_message: "owner_hangup_before_bridge:user_busy",
    });
    expect(chains[6].is).toHaveBeenCalledWith(
      "fallback_triggered_at",
      null
    );
    expect(chains[6].in).toHaveBeenCalledWith("status", [
      "dialing",
      "error",
    ]);
    expect(
      chains.filter((chain) => chain.insert.mock.calls.length > 0)
    ).toHaveLength(1);
    expect(mocks.hangup).toHaveBeenCalledOnce();
    expect(mocks.hangup).toHaveBeenCalledWith(
      ATTEMPT.inbound_call_control_id,
      {}
    );
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledOnce();
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
      ATTEMPT.caller_phone,
      ATTEMPT.business_id,
      ATTEMPT.call_session_id
    );
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("preserves a claimed fallback across late owner-answer and call.bridged events", async () => {
    const targetState = forwardTargetState();
    const fallbackAttempt = {
      ...ATTEMPT,
      status: "fallback_triggered",
      fallback_triggered_at: "2026-08-11T12:00:00.000Z",
      error_message: "owner_hangup_before_bridge:user_busy",
    };
    queueResults(
      { data: ATTEMPT, error: null },
      { data: fallbackAttempt, error: null },
      { data: fallbackAttempt, error: null },
      { data: null, error: null }
    );
    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.hangup",
        {
          call_control_id: ATTEMPT.outbound_call_control_id,
          client_state: targetState,
          hangup_cause: "user_busy",
        },
        "evt_voice_late_events_fallback"
      )
    );

    const fallbackResponse = await voiceWebhook(request());

    expect(fallbackResponse.status).toBe(200);
    expect(chains).toHaveLength(2);
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledOnce();

    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.answered",
        {
          call_control_id: ATTEMPT.outbound_call_control_id,
          client_state: targetState,
        },
        "evt_voice_late_events_owner_answer"
      )
    );
    const ownerAnswerResponse = await voiceWebhook(request());
    const chainsAfterOwnerAnswer = chains.length;

    mocks.unwrap.mockResolvedValueOnce(
      voiceEvent(
        "call.bridged",
        {
          call_control_id: ATTEMPT.outbound_call_control_id,
          client_state: targetState,
        },
        "evt_voice_late_events_bridged"
      )
    );
    const bridgedResponse = await voiceWebhook(request());

    expect(ownerAnswerResponse.status).toBe(200);
    expect(bridgedResponse.status).toBe(200);
    expect(chainsAfterOwnerAnswer).toBe(2);
    expect(chains).toHaveLength(4);
    expect(chains[3].update).toHaveBeenCalledWith({
      status: "connected",
      connected_at: expect.any(String),
    });
    expect(chains[3].eq).toHaveBeenCalledWith("status", "dialing");
    expect(chains[3].is).toHaveBeenCalledWith("fallback_triggered_at", null);
    expect(mocks.hangup).toHaveBeenCalledOnce();
    expect(mocks.hangup).toHaveBeenCalledWith(
      ATTEMPT.inbound_call_control_id,
      {}
    );
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledOnce();
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
      ATTEMPT.caller_phone,
      ATTEMPT.business_id,
      ATTEMPT.call_session_id
    );
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("re-opens the fallback claim, releases the event, and 500s when the SMS send fails", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.hangup", {
        call_control_id: "cc_inbound",
        client_state: HANGUP_STATE,
        hangup_cause: "originator_cancel",
      })
    );
    queueResults(
      { data: ATTEMPT, error: null }, // getForwardingAttemptById
      { data: { ...ATTEMPT, status: "abandoned" }, error: null }, // fallback claim
      { error: null } // re-open update
    );
    mocks.sendMissedCallSMS.mockRejectedValue(new Error("telnyx unreachable"));

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    // The re-open write: status 'error' + cleared claim timestamp so the
    // redelivered hangup re-enters the fallback and re-sends.
    const reopenChain = chains[2];
    expect(reopenChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", fallback_triggered_at: null })
    );
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_call_hangup"
    );
  });

  it("releases and 500s when the fallback claim query errors", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.hangup", {
        call_control_id: "cc_inbound",
        client_state: HANGUP_STATE,
        hangup_cause: "originator_cancel",
      })
    );
    queueResults(
      { data: ATTEMPT, error: null },
      { data: null, error: { message: "connection reset" } } // claim errors
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).toHaveBeenCalled();
  });

  it("releases and 500s when the voicemail-path SMS fails on recording.saved", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.recording.saved", {
        client_state: RECORDING_STATE,
        recording_urls: { mp3: "https://example.test/rec.mp3" },
      })
    );
    mocks.sendMissedCallSMS.mockRejectedValue(new Error("telnyx unreachable"));

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
      ATTEMPT.caller_phone,
      ATTEMPT.business_id,
      "cc_inbound"
    );
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_call_recording_saved"
    );
  });

  it("passes the provider session ID through the recording-error SMS path", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.recording.error", {
        client_state: RECORDING_STATE,
        call_session_id: "sess_recording_error",
      })
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.sendMissedCallSMS).toHaveBeenCalledWith(
      ATTEMPT.caller_phone,
      ATTEMPT.business_id,
      "sess_recording_error"
    );
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("keeps the log-and-ack swallow for real-time call-control failures", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.initiated", {
        direction: "incoming",
        from: "+15745550100",
        to: "+15745550300",
        call_control_id: "cc_rt",
      })
    );
    queueResults({ data: null, error: null }); // no active phone number row
    mocks.reject.mockRejectedValue(new Error("verb failed"));

    const response = await voiceWebhook(request());

    // Retrying answer()/reject() seconds later on a dead call cannot help:
    // real-time verbs ack 200 and keep the claim.
    expect(response.status).toBe(200);
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("acknowledges and rejects a genuinely unknown destination number", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.initiated", {
        direction: "incoming",
        from: "+15745550100",
        to: "+15745550300",
        call_control_id: "cc_unknown",
      })
    );
    queueResults({ data: null, error: null });

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.reject).toHaveBeenCalledWith("cc_unknown", {
      cause: "USER_BUSY",
    });
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("releases the claim and returns 500 when destination lookup errors", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.initiated", {
        direction: "incoming",
        from: "+15745550100",
        to: "+15745550300",
        call_control_id: "cc_phone_lookup_error",
      })
    );
    queueResults({ data: null, error: { message: "connection reset" } });

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_call_initiated"
    );
  });

  it("rejects a call without paid execution when the subscription is canceled", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.initiated", {
        direction: "incoming",
        from: "+15745550100",
        to: "+15745550300",
        call_control_id: "cc_canceled",
      })
    );
    queueResults({ data: { business_id: ATTEMPT.business_id }, error: null });
    mocks.resolveBusinessEntitlements.mockResolvedValue({
      businessId: ATTEMPT.business_id,
      plan: "sms_and_chat",
      status: "canceled",
      source: "subscription",
      active: false,
      cancelAtPeriodEnd: false,
    });
    mocks.canUseFeature.mockReturnValue(false);

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.reject).toHaveBeenCalledWith("cc_canceled", {
      cause: "USER_BUSY",
    });
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("releases the claim and returns 500 when paid access cannot be resolved", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.initiated", {
        direction: "incoming",
        from: "+15745550100",
        to: "+15745550300",
        call_control_id: "cc_entitlement_error",
      })
    );
    queueResults({ data: { business_id: ATTEMPT.business_id }, error: null });
    mocks.resolveBusinessEntitlements.mockRejectedValue(
      new Error("billing database unavailable")
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_call_initiated"
    );
  });

  it("releases the claim and returns 500 when business lookup errors", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.initiated", {
        direction: "incoming",
        from: "+15745550100",
        to: "+15745550300",
        call_control_id: "cc_business_lookup_error",
      })
    );
    queueResults(
      { data: { business_id: ATTEMPT.business_id }, error: null },
      { data: null, error: { message: "connection reset" } }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_call_initiated"
    );
  });

  it("treats a provisioned number pointing to a missing business as retryable", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.initiated", {
        direction: "incoming",
        from: "+15745550100",
        to: "+15745550300",
        call_control_id: "cc_missing_business",
      })
    );
    queueResults(
      { data: { business_id: ATTEMPT.business_id }, error: null },
      { data: null, error: null }
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_call_initiated"
    );
  });

  it.each([
    {
      leg: "inbound",
      callControlId: ATTEMPT.inbound_call_control_id,
      state: HANGUP_STATE,
    },
    {
      leg: "outbound",
      callControlId: ATTEMPT.outbound_call_control_id,
      state: forwardTargetState(),
    },
  ])(
    "ends a successfully bridged call without missed-call SMS when the $leg leg hangs up first",
    async ({ leg, callControlId, state }) => {
      const connectedAttempt = {
        ...ATTEMPT,
        status: "connected",
        connected_at: "2026-08-11T12:00:00.000Z",
      };
      mocks.unwrap
        .mockResolvedValueOnce(
          voiceEvent(
            "call.bridged",
            {
              call_control_id: ATTEMPT.outbound_call_control_id,
              client_state: forwardTargetState(),
            },
            `evt_voice_success_bridged_${leg}`
          )
        )
        .mockResolvedValueOnce(
          voiceEvent(
            "call.hangup",
            {
              call_control_id: callControlId,
              client_state: state,
              hangup_cause: "normal_clearing",
            },
            `evt_voice_success_hangup_${leg}`
          )
        );
      queueResults(
        { data: ATTEMPT, error: null },
        { data: { id: ATTEMPT.id }, error: null },
        { data: connectedAttempt, error: null },
        { error: null }
      );

      const bridgedResponse = await voiceWebhook(request());
      const hangupResponse = await voiceWebhook(request());

      expect(bridgedResponse.status).toBe(200);
      expect(hangupResponse.status).toBe(200);
      expect(chains).toHaveLength(4);
      expect(chains[1].update).toHaveBeenCalledWith({
        status: "connected",
        connected_at: expect.any(String),
      });
      expect(chains[1].eq).toHaveBeenCalledWith("status", "dialing");
      expect(chains[1].is).toHaveBeenCalledWith(
        "fallback_triggered_at",
        null
      );
      expect(chains[3].update).toHaveBeenCalledWith({
        status: "ended",
        ended_at: expect.any(String),
      });
      expect(chains[3].eq).toHaveBeenCalledWith("status", "connected");
      expect(mocks.hangup).not.toHaveBeenCalled();
      expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
      expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
    }
  );

  it("honors RetryableWebhookError from a non-durable event type (bridged connected-mark failure)", async () => {
    // Durability is a property of the side effect: call.bridged is not in
    // DURABLE_EVENT_TYPES, but a failed connected-mark must retry (a lost
    // mark makes a later hangup fire a spurious missed-call SMS).
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.bridged", {
        call_control_id: "cc_outbound",
        client_state: HANGUP_STATE,
      })
    );
    queueResults(
      { data: ATTEMPT, error: null }, // getForwardingAttemptById
      { data: null, error: { message: "connection reset" } } // connected-mark
    );

    const response = await voiceWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_voice_call_bridged"
    );
  });

  it("dedups duplicate voice events without running handlers", async () => {
    mocks.unwrap.mockResolvedValue(
      voiceEvent("call.hangup", { call_control_id: "cc_inbound" })
    );
    mocks.markProcessedOnce.mockResolvedValue(false);

    const response = await voiceWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.dial).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.startPlayback).not.toHaveBeenCalled();
    expect(mocks.speak).not.toHaveBeenCalled();
    expect(mocks.startRecording).not.toHaveBeenCalled();
    expect(mocks.sendMissedCallSMS).not.toHaveBeenCalled();
  });
});
