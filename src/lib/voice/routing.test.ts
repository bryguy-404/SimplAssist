import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Telnyx from "telnyx";
import {
  handlePilotEvent,
  pilotClientState,
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
    if (session.status !== "closed") {
      session.status = "closed";
      session.outcome = args.p_outcome as string;
      session.fallback_pending = args.p_fallback as boolean;
    }
    return { error: null };
  });
  const actions = {
    startPlayback: vi.fn().mockResolvedValue({}),
    speak: vi.fn().mockResolvedValue({}),
    startRecording: vi.fn().mockResolvedValue({}),
    startStreaming: vi.fn().mockResolvedValue({}),
    hangup: vi.fn().mockResolvedValue({}),
  };
  const deps: PilotRoutingDependencies = {
    db: { from, rpc } as unknown as SupabaseClient,
    telnyx: { calls: { actions } } as unknown as Telnyx,
    workerReady: vi.fn().mockResolvedValue(true),
    sendFallback: vi.fn().mockResolvedValue(undefined),
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
  it("preserves ringback, completes the notice, then records and streams", async () => {
    const f = fixture();
    await handlePilotEvent(f.deps, "call.answered", f.payload("initial"), true);
    expect(f.actions.startPlayback.mock.calls[0][1].audio_url).toContain(
      "voicemail-ringback-11s-v1.wav",
    );
    expect(f.actions.startRecording).not.toHaveBeenCalled();
    await handlePilotEvent(
      f.deps,
      "call.playback.ended",
      f.payload("ringing", { status: "completed" }),
      true,
    );
    expect(f.actions.speak.mock.calls[0][1].payload).toContain("AI assistant");
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
    expect(f.actions.startRecording.mock.invocationCallOrder[0]).toBeLessThan(
      f.actions.startStreaming.mock.invocationCallOrder[0],
    );
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
