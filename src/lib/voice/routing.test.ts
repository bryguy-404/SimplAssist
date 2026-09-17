import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Telnyx from "telnyx";
import {
  drainFallback,
  handlePilotEvent,
  pilotClientState,
  admitCommercialVoice,
  startCommercialVoice,
  checkVoiceWorkerReady,
  type PilotRoutingDependencies,
} from "./routing";
import { PILOT_BUSINESS_ID, PILOT_PHONE, type VoiceSession } from "./types";

function fixture(status: VoiceSession["status"] = "ringing") {
  const session = {
    id: "voice-call",
    business_id: PILOT_BUSINESS_ID,
    call_control_id: "control",
    call_session_id: "call-session",
    caller_phone: "+15555550101",
    called_phone: PILOT_PHONE,
    response_mode: "voice",
    status,
    reserved_seconds: 600,
    created_at: "2026-09-14T12:00:00Z",
    fallback_pending: false,
    fallback_completed_at: null,
    fallback_claimed_at: null,
  } as VoiceSession;
  const recordings: Record<string, unknown>[] = [];
  function from(table: string) {
    let update: Record<string, unknown> | null = null;
    const filters: [string, unknown][] = [];
    let statuses: string[] | null = null;
    const q = {
      select() {
        return this;
      },
      eq(key: string, value: unknown) {
        filters.push([key, value]);
        return this;
      },
      is(key: string, value: unknown) {
        filters.push([key, value]);
        return this;
      },
      in(_key: string, values: string[]) {
        statuses = values;
        return this;
      },
      update(values: Record<string, unknown>) {
        update = values;
        return this;
      },
      upsert: (values: Record<string, unknown>) => {
        if (table === "voice_recordings") recordings.push(values);
        return Promise.resolve({ error: null });
      },
      maybeSingle: () => run(true),
      single: () => run(true),
      then: (resolve: (result: unknown) => void) =>
        Promise.resolve(run(false)).then(resolve),
    };
    function run(single: boolean) {
      const found =
        filters.every(
          ([key, value]) =>
            (session as unknown as Record<string, unknown>)[key] === value,
        ) &&
        (!statuses || statuses.includes(session.status));
      if (!found) return { data: single ? null : [], error: null };
      if (update) Object.assign(session, update);
      return { data: single ? { ...session } : [{ ...session }], error: null };
    }
    return q;
  }
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    if (_name === "prepare_preinformed_voice_session")
      return { data: null, error: null };
    if (_name.startsWith("record_voice_customer_")) return { data: null, error: null };
    if (session.status !== "closed") {
      session.status = "closed";
      session.outcome = args.p_outcome as string;
      session.fallback_pending = args.p_fallback as boolean;
    }
    return { error: null };
  });
  const actions = {
    startPlayback: vi.fn().mockResolvedValue({}),
    stopPlayback: vi.fn().mockResolvedValue({}),
    speak: vi.fn().mockResolvedValue({}),
    startRecording: vi.fn().mockResolvedValue({}),
    startStreaming: vi.fn().mockResolvedValue({}),
    hangup: vi.fn().mockResolvedValue({}),
  };
  const deps: PilotRoutingDependencies = {
    db: { from, rpc } as unknown as SupabaseClient,
    telnyx: { calls: { actions } } as unknown as Telnyx,
    workerReady: vi.fn().mockResolvedValue(true),
    commercialWorkerReady: vi.fn().mockResolvedValue(true),
    sendFallback: vi.fn(async (_session, claim) => {
      await claim();
    }),
    workerUrl: "https://voice.example",
    appUrl: "https://simplassist.com",
    streamSecret: "s".repeat(32),
    profile: "pcm16",
  };
  const payload = (phase: string, extra: Record<string, unknown> = {}) => ({
    call_control_id: session.call_control_id,
    call_session_id: session.call_session_id,
    client_state: pilotClientState(session, phase),
    ...extra,
  });
  return { session, recordings, deps, actions, payload, rpc };
}

describe("existing-number voice routing", () => {
  it.each([undefined, 0, 1])("requires natural-opening capability only for stored v2 calls (capability %s)", async (capability) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      ready: true, model: "gpt-live-1", profile: "pcm16", commercialProtocol: 2, actionProtocol: 1,
      naturalOpeningProtocol: capability,
    })));
    try {
      expect(await checkVoiceWorkerReady("https://voice.example", "x".repeat(32), true)).toBe(true);
      expect(await checkVoiceWorkerReady("https://voice.example", "x".repeat(32), true, true)).toBe(capability === 1);
    } finally { fetch.mockRestore(); }
  });
  it("routes a natural opening to its capable worker without claiming notice or starting recording in the app", async () => {
    const f = fixture(); Object.assign(f.session, { access_source: "commercial", disclosure_version: 2 });
    await startCommercialVoice(f.deps, f.session);
    expect(f.deps.commercialWorkerReady).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.actions.startStreaming).toHaveBeenCalledOnce();
    expect(new URL(f.actions.startStreaming.mock.calls[0][1].stream_url).searchParams.get("opening_ringback")).toBe("v1");
    expect(f.actions.startRecording).not.toHaveBeenCalled(); expect(f.actions.speak).not.toHaveBeenCalled();
    expect(f.session.notice_completed_at).toBeUndefined();
    await handlePilotEvent(f.deps, "call.speak.ended", f.payload("notice", { status: "completed" }), true);
    expect(f.session.notice_completed_at).toBeUndefined(); expect(f.actions.startRecording).not.toHaveBeenCalled();
  });
  it("keeps v2 closed before media when the worker lacks natural-opening support", async () => {
    const f = fixture(); Object.assign(f.session, { access_source: "commercial", disclosure_version: 2 });
    vi.mocked(f.deps.commercialWorkerReady!).mockImplementation(async (natural) => !natural);
    await expect(startCommercialVoice(f.deps, f.session)).rejects.toThrow("voice_worker_unavailable");
    expect(f.actions.startStreaming).not.toHaveBeenCalled(); expect(f.actions.speak).not.toHaveBeenCalled();
  });
  it("uses the same natural opening capability for a protected pilot rehearsal", async () => {
    const f = fixture(); Object.assign(f.session, { access_source: "pilot", disclosure_version: 2, public_notice_rehearsal: true });
    await handlePilotEvent(f.deps, "call.playback.ended", f.payload("ringing", { status: "completed" }), true);
    expect(f.deps.commercialWorkerReady).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.actions.startStreaming).toHaveBeenCalledOnce(); expect(f.actions.startRecording).not.toHaveBeenCalled();
    expect(f.actions.speak).not.toHaveBeenCalled(); expect(f.session.notice_completed_at).toBeUndefined();
  });
  it("requires a matching commercial admission identity and the upgraded worker", async () => {
    const f = fixture();
    f.session.access_source = "commercial";
    f.rpc.mockResolvedValue({ data: f.session, error: null } as never);
    const args = { businessId: f.session.business_id, caller: f.session.caller_phone, called: f.session.called_phone, callControlId: f.session.call_control_id, callSessionId: f.session.call_session_id };
    expect(await admitCommercialVoice(f.deps, args)).toMatchObject({ access_source: "commercial" });
    expect(f.rpc).toHaveBeenCalledWith("admit_voice_commercial", expect.objectContaining({ p_worker_ready: true }));
    f.rpc.mockResolvedValue({ data: { ...f.session, business_id: "other" }, error: null } as never);
    await expect(admitCommercialVoice(f.deps, args)).rejects.toThrow("voice_commercial_identity_invalid");
  });
  it("freezes a closed-rollout text denial without probing the worker", async () => {
    const f = fixture();
    Object.assign(f.session, { access_source: "commercial", response_mode: "text", text_fallback_enabled: false });
    f.rpc.mockResolvedValue({ data: f.session, error: null } as never);
    const result = await admitCommercialVoice(f.deps, { businessId: f.session.business_id,
      caller: f.session.caller_phone, called: f.session.called_phone, callControlId: f.session.call_control_id,
      callSessionId: f.session.call_session_id }, false);
    expect(result).toMatchObject({ response_mode: "text", text_fallback_enabled: false });
    expect(f.deps.commercialWorkerReady).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledWith("admit_voice_commercial", expect.objectContaining({ p_worker_ready: false }));
  });
  it("starts commercial voice after ringing without preparation or a prior-disclosure bypass", async () => {
    const f = fixture();
    f.session.access_source = "commercial";
    f.session.prior_disclosure_acknowledged_at = "2026-09-13T00:00:00Z";
    await startCommercialVoice(f.deps, f.session);
    expect(f.actions.startPlayback).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalledWith("prepare_preinformed_voice_session", expect.anything());
    expect(f.actions.speak).toHaveBeenCalledOnce();
    expect(f.actions.startRecording).not.toHaveBeenCalled();
    await handlePilotEvent(f.deps, "call.speak.ended", f.payload("notice", { status: "completed" }), true);
    expect(f.deps.commercialWorkerReady).toHaveBeenCalledOnce();
    expect(new URL(f.actions.startStreaming.mock.calls[0][1].stream_url).searchParams.has("opening_ringback")).toBe(false);
  });
  it("streams the public same-Marin notice while ringback continues without starting recording or Polly", async () => {
    const f = fixture();
    Object.assign(f.session, { access_source: "commercial", disclosure_version: 1, prior_disclosure_acknowledged_at: "2026-09-13T00:00:00Z" });
    await startCommercialVoice(f.deps, f.session);
    expect(f.session.status).toBe("notice");
    expect(f.actions.startPlayback).toHaveBeenCalledOnce();
    expect(f.actions.startStreaming).toHaveBeenCalledOnce();
    expect(new URL(f.actions.startStreaming.mock.calls[0][1].stream_url).searchParams.get("opening_ringback")).toBe("v1");
    expect(f.actions.startRecording).not.toHaveBeenCalled(); expect(f.actions.speak).not.toHaveBeenCalled();
    await handlePilotEvent(f.deps, "call.speak.ended", f.payload("notice", { status: "completed" }), true);
    expect(f.session.status).toBe("notice"); expect(f.session.notice_completed_at).toBeUndefined();
    expect(f.actions.startRecording).not.toHaveBeenCalled(); expect(f.actions.startStreaming).toHaveBeenCalledOnce();
  });
  it("takes the protected pilot rehearsal through the public opening without its prior acknowledgment or preparation", async () => {
    const f = fixture();
    Object.assign(f.session, { access_source: "pilot", disclosure_version: 1, public_notice_rehearsal: true, prior_disclosure_acknowledged_at: "2026-09-13T00:00:00Z" });
    await handlePilotEvent(f.deps, "call.playback.ended", f.payload("ringing", { status: "completed" }), true);
    expect(f.deps.commercialWorkerReady).toHaveBeenCalledOnce();
    expect(f.rpc).not.toHaveBeenCalledWith("prepare_preinformed_voice_session", expect.anything());
    expect(f.actions.speak).not.toHaveBeenCalled(); expect(f.actions.startRecording).not.toHaveBeenCalled();
    expect(f.actions.startStreaming).toHaveBeenCalledOnce(); expect(f.session.status).toBe("notice");
  });
  it("fails a new public opening closed when its upgraded worker is unavailable", async () => {
    const f = fixture(); Object.assign(f.session, { access_source: "commercial", disclosure_version: 1 });
    vi.mocked(f.deps.commercialWorkerReady!).mockResolvedValue(false);
    await expect(startCommercialVoice(f.deps, f.session)).rejects.toThrow("voice_worker_unavailable");
    expect(f.actions.startStreaming).not.toHaveBeenCalled(); expect(f.actions.startRecording).not.toHaveBeenCalled();
  });
  it("preserves original signed commercial end evidence across retries without arrival-time writes", async () => {
    const f = fixture("active");
    f.session.access_source = "commercial";
    const payload = f.payload("conversation", { end_time: "2026-09-14T12:01:30Z" });
    const evidence = { eventId: "telnyx-end-1", occurredAt: "2026-09-14T12:01:31Z" };
    await handlePilotEvent(f.deps, "call.hangup", payload, true, evidence);
    await handlePilotEvent(f.deps, "call.hangup", payload, true, evidence);
    expect(f.rpc).toHaveBeenCalledWith("record_voice_customer_end", {
      p_session_id: f.session.id, p_event_id: "telnyx-end-1", p_ended_at: "2026-09-14T12:01:30Z",
    });
    expect(f.session).not.toHaveProperty("phone_ended_at");
    expect(f.deps.sendFallback).not.toHaveBeenCalled();
  });
  it("does not invent a customer end timestamp when a hangup lacks original evidence", async () => {
    const f = fixture("active");
    f.session.access_source = "commercial";
    await handlePilotEvent(f.deps, "call.hangup", f.payload("conversation"), true, { eventId: "end-no-time" });
    expect(f.rpc).toHaveBeenCalledWith("record_voice_customer_termination", expect.objectContaining({ p_event_id: "end-no-time" }));
    expect(f.rpc).not.toHaveBeenCalledWith("record_voice_customer_end", expect.anything());
  });
  it.each([false, true])("honors the frozen denied-voice text fallback=%s after hangup and duplicate recording callbacks", async (enabled) => {
    const f = fixture();
    f.session.access_source = "commercial";
    f.session.response_mode = "text";
    f.session.text_fallback_enabled = enabled;
    await handlePilotEvent(f.deps, "call.hangup", f.payload("voicemail"), true);
    await handlePilotEvent(f.deps, "call.recording.saved", f.payload("voicemail", { recording_id: "voicemail" }), true);
    expect(f.deps.sendFallback).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(f.recordings).toEqual([]);
  });
  it("starts the live voice directly for a previously informed tester without inventing a spoken notice", async () => {
    const f = fixture();
    const prepared = {
      ...f.session,
      status: "starting",
      prior_disclosure_acknowledged_at: "2026-09-13T12:00:00Z",
      media_start_requested_at: "2026-09-14T12:00:11Z",
    } as VoiceSession;
    f.rpc.mockImplementation(async () => {
      Object.assign(f.session, prepared);
      return { data: prepared as never, error: null };
    });
    const payload = f.payload("ringing", { status: "completed" });
    await handlePilotEvent(f.deps, "call.playback.ended", payload, true);
    await handlePilotEvent(f.deps, "call.playback.ended", payload, true);
    expect(f.actions.speak).not.toHaveBeenCalled();
    expect(f.actions.stopPlayback).not.toHaveBeenCalled();
    expect(
      new URL(
        f.actions.startStreaming.mock.calls[0][1].stream_url,
      ).searchParams.get("opening_ringback"),
    ).toBe("v1");
    expect(f.session.notice_completed_at).toBeFalsy();
    expect(f.actions.startRecording).toHaveBeenCalledTimes(2);
    expect(f.actions.startStreaming.mock.calls[0]).toEqual(
      f.actions.startStreaming.mock.calls[1],
    );
    expect(f.actions.startRecording.mock.calls[0]).toEqual(
      f.actions.startRecording.mock.calls[1],
    );
  });
  it("fails closed when prior-disclosure lookup fails", async () => {
    const f = fixture();
    f.rpc.mockResolvedValueOnce({ error: { message: "unavailable" } } as never);
    await handlePilotEvent(
      f.deps,
      "call.playback.ended",
      f.payload("ringing", { status: "completed" }),
      true,
    );
    expect(f.actions.startRecording).not.toHaveBeenCalled();
    expect(f.actions.startStreaming).not.toHaveBeenCalled();
    expect(f.deps.sendFallback).toHaveBeenCalledOnce();
  });
  it("preserves ringback, completes the notice, then records and streams", async () => {
    const f = fixture();
    await handlePilotEvent(f.deps, "call.answered", f.payload("initial"), true);
    expect(f.actions.startPlayback.mock.calls[0][1].audio_url).toContain(
      "voicemail-ringback-11s-v1.wav",
    );
    expect(f.actions.startPlayback.mock.calls[1][1]).toMatchObject({
      loop: 3,
      command_id: "voice-connecting-ring-voice-call",
    });
    expect(f.actions.startRecording).not.toHaveBeenCalled();
    await handlePilotEvent(
      f.deps,
      "call.playback.ended",
      f.payload("ringing", { status: "completed" }),
      true,
    );
    expect(f.actions.speak.mock.calls[0][1].payload).toContain("AI assistant");
    expect(f.actions.stopPlayback).toHaveBeenCalledOnce();
    expect(f.actions.stopPlayback.mock.invocationCallOrder[0]).toBeLessThan(
      f.actions.speak.mock.invocationCallOrder[0],
    );
    expect(f.actions.startRecording).not.toHaveBeenCalled();
    await handlePilotEvent(
      f.deps,
      "call.speak.ended",
      f.payload("notice", { status: "completed" }),
      true,
    );
    expect(f.session.notice_completed_at).toBeTruthy();
    expect(f.actions.startRecording).toHaveBeenCalledOnce();
    expect(f.actions.startStreaming.mock.calls[0][1]).toMatchObject({
      stream_codec: "L16",
      stream_bidirectional_sampling_rate: 16000,
      stream_track: "inbound_track",
    });
    expect(
      new URL(
        f.actions.startStreaming.mock.calls[0][1].stream_url,
      ).searchParams.has("opening_ringback"),
    ).toBe(false);
    expect(f.actions.startRecording.mock.invocationCallOrder[0]).toBeLessThan(
      f.actions.startStreaming.mock.invocationCallOrder[0],
    );
  });
  it("queues a bounded continuation before the first ring ends with stable retry IDs", async () => {
    const f = fixture();
    await handlePilotEvent(f.deps, "call.answered", f.payload("initial"), true);
    await handlePilotEvent(f.deps, "call.answered", f.payload("initial"), true);
    expect(f.actions.startPlayback.mock.calls[0]).toEqual(
      f.actions.startPlayback.mock.calls[2],
    );
    expect(f.actions.startPlayback.mock.calls[1]).toEqual(
      f.actions.startPlayback.mock.calls[3],
    );
    expect(f.actions.startPlayback.mock.calls[0][1].loop).toBeUndefined();
    expect(f.actions.startPlayback.mock.calls[1][1].loop).toBe(3);
    expect(f.actions.startStreaming).not.toHaveBeenCalled();
  });
  it("ignores the cancelled ringback callback after a live greeting handoff", async () => {
    const f = fixture("active");
    await handlePilotEvent(
      f.deps,
      "call.playback.ended",
      f.payload("ringing", { status: "cancelled" }),
      true,
    );
    expect(f.actions.startStreaming).not.toHaveBeenCalled();
    expect(f.actions.speak).not.toHaveBeenCalled();
    expect(f.deps.sendFallback).not.toHaveBeenCalled();
  });
  it("fails safely if continuation ringback cannot be queued", async () => {
    const f = fixture();
    f.actions.startPlayback
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("provider_failure"));
    await handlePilotEvent(f.deps, "call.answered", f.payload("initial"), true);
    expect(f.actions.startStreaming).not.toHaveBeenCalled();
    expect(f.actions.hangup).toHaveBeenCalledOnce();
    expect(f.deps.sendFallback).toHaveBeenCalledOnce();
  });
  it("uses stable command IDs and credentials across webhook retries", async () => {
    const f = fixture("notice");
    const payload = f.payload("notice", { status: "completed" });
    await handlePilotEvent(f.deps, "call.speak.ended", payload, true);
    await handlePilotEvent(f.deps, "call.speak.ended", payload, true);
    expect(f.actions.startStreaming.mock.calls[0]).toEqual(
      f.actions.startStreaming.mock.calls[1],
    );
  });
  it("records a voice callback without hanging up or sending voicemail text", async () => {
    const f = fixture("active");
    expect(
      await handlePilotEvent(
        f.deps,
        "call.recording.saved",
        f.payload("conversation", {
          recording_id: "recording",
          recording_urls: { mp3: "PRIVATE_URL" },
        }),
        false,
      ),
    ).toBe(true);
    expect(f.recordings[0]).toMatchObject({
      recording_id: "recording",
      session_id: f.session.id,
    });
    expect(JSON.stringify(f.recordings)).not.toContain("PRIVATE_URL");
    expect(f.actions.hangup).not.toHaveBeenCalled();
    expect(f.deps.sendFallback).not.toHaveBeenCalled();
  });
  it("suppresses generic missed-call text after normal voice hangup, including late errors", async () => {
    const f = fixture("active");
    await handlePilotEvent(
      f.deps,
      "call.hangup",
      f.payload("conversation"),
      true,
    );
    await handlePilotEvent(
      f.deps,
      "call.recording.error",
      f.payload("conversation"),
      true,
    );
    expect(f.session.outcome).toBe("caller_hangup");
    expect(f.deps.sendFallback).not.toHaveBeenCalled();
  });
  it("uses one eligible text fallback after a technical failure", async () => {
    const f = fixture("active");
    await handlePilotEvent(
      f.deps,
      "call.streaming.failed",
      f.payload("conversation"),
      true,
    );
    await handlePilotEvent(
      f.deps,
      "call.hangup",
      f.payload("conversation"),
      true,
    );
    await handlePilotEvent(
      f.deps,
      "call.recording.error",
      f.payload("conversation"),
      true,
    );
    expect(f.deps.sendFallback).toHaveBeenCalledOnce();
    expect(f.session.fallback_pending).toBe(false);
    expect(f.actions.hangup).toHaveBeenCalledOnce();
  });
  it("never starts recording after an incomplete notice", async () => {
    const f = fixture("notice");
    await handlePilotEvent(
      f.deps,
      "call.speak.ended",
      f.payload("notice", { status: "failed" }),
      true,
    );
    expect(f.actions.startRecording).not.toHaveBeenCalled();
    expect(f.actions.startStreaming).not.toHaveBeenCalled();
    expect(f.deps.sendFallback).toHaveBeenCalledOnce();
  });
  it("preserves abandonment during ringing and leaves text-mode calls to the legacy flow", async () => {
    const f = fixture();
    await handlePilotEvent(f.deps, "call.hangup", f.payload("ringing"), true);
    expect(f.session.outcome).toBe("caller_abandoned");
    expect(f.deps.sendFallback).not.toHaveBeenCalled();
    f.session.response_mode = "text";
    expect(
      await handlePilotEvent(
        f.deps,
        "call.recording.saved",
        f.payload("voicemail"),
        true,
      ),
    ).toBe(false);
  });
  it("rejects conflicting callback identities", async () => {
    const f = fixture("active");
    await expect(
      handlePilotEvent(
        f.deps,
        "call.hangup",
        f.payload("conversation", { call_session_id: "other" }),
        true,
      ),
    ).rejects.toThrow("identity_mismatch");
    expect(f.rpc).not.toHaveBeenCalled();
  });
});

describe("voice fallback delivery claim", () => {
  it("allows only one provider send when webhook and maintenance race", async () => {
    const f = fixture("closed");
    f.session.fallback_pending = true;
    const provider = vi.fn();
    f.deps.sendFallback = vi.fn(async (_s, claim) => {
      if (await claim()) provider();
    });
    await Promise.all([
      drainFallback(f.deps, f.session.id),
      drainFallback(f.deps, f.session.id),
    ]);
    expect(provider).toHaveBeenCalledOnce();
    await drainFallback(f.deps, f.session.id);
    expect(provider).toHaveBeenCalledOnce();
    expect(f.session.fallback_completed_at).not.toBeNull();
  });
  it("does not retry an ambiguous send, even after a worker restart", async () => {
    const f = fixture("closed");
    f.session.fallback_pending = true;
    const provider = vi.fn().mockRejectedValue(new Error("response lost"));
    f.deps.sendFallback = vi.fn(async (_s, claim) => {
      if (await claim()) await provider();
    });
    await expect(drainFallback(f.deps, f.session.id)).rejects.toThrow(
      "response lost",
    );
    await drainFallback(f.deps, f.session.id);
    expect(provider).toHaveBeenCalledOnce();
    expect(f.session).toMatchObject({
      fallback_error_code: "delivery_unconfirmed",
      fallback_completed_at: null,
    });
  });
  it("retries a preflight failure that never attempted a send", async () => {
    const f = fixture("closed");
    f.session.fallback_pending = true;
    const send = vi.fn(
      async (_s: VoiceSession, claim: () => Promise<boolean>) => {
        await claim();
      },
    );
    send.mockRejectedValueOnce(new Error("database temporarily unavailable"));
    f.deps.sendFallback = send;
    await expect(drainFallback(f.deps, f.session.id)).rejects.toThrow();
    expect(f.session).toHaveProperty("fallback_claimed_at", null);
    await drainFallback(f.deps, f.session.id);
    expect(f.session.fallback_completed_at).not.toBeNull();
  });
});
