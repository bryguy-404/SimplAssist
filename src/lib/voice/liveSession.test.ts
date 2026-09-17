import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { LiveCall, type LiveSessionOptions } from "./liveSession";
import {
  AUDIO_PROFILES,
  AudioQueue,
  InboundReorderBuffer,
  validateMediaFormat,
  hasAudibleAudio,
} from "./audio";
import { CallTranscript } from "./transcript";
import type { VoiceSession } from "./types";
import type { VoiceStore } from "./store";
import { VOICE_RECEPTIONIST_FLOW } from "./actionInstructions";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  appendByteLimit: number | null = null;
  send(raw: string) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    // Fixed public control messages use a conservative UTF-8 byte budget:
    // <=500 bytes cannot exceed the provider's 500 byte-BPE token limit.
    // session.start has its own larger instruction budget and is not an append.
    if (this.appendByteLimit !== null &&
      ["session.instructions.append", "session.commentary.append"].includes(event.type) &&
      Buffer.byteLength(event.content, "utf8") > this.appendByteLimit) {
      queueMicrotask(() => this.event({ type: "error", error: {
        code: "content_too_long", type: "invalid_request_error", param: "content",
        client_event_id: event.event_id,
      } }));
    }
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  terminate() {
    this.close();
  }
  event(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
  asWebSocket() {
    return this as unknown as WebSocket;
  }
}
const session = {
  id: "call",
  business_id: "business",
  call_control_id: "control",
  call_session_id: "telnyx-session",
  caller_phone: "+15555550101",
  called_phone: "+15742638634",
  reserved_seconds: 600,
} as VoiceSession;

function harness(
  profile: "pcm16" | "pcmu8" = "pcm16",
  connectingRingback = false,
  overrides: Partial<LiveSessionOptions> = {},
) {
  const phone = new Socket();
  const live = new Socket();
  const store = {
    activate: vi.fn().mockResolvedValue(undefined),
    beginDisclosure: vi.fn().mockResolvedValue(undefined),
    completeDisclosure: vi.fn().mockResolvedValue(undefined),
    recordingStarted: vi.fn().mockResolvedValue(undefined),
    handoffStarted: vi.fn().mockResolvedValue(undefined),
    handoffAcknowledged: vi.fn().mockResolvedValue(undefined),
    fragment: vi.fn().mockResolvedValue(undefined),
    usage: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(true),
    audioSent: vi.fn().mockResolvedValue(undefined),
    playbackAcknowledged: vi.fn().mockResolvedValue(undefined),
    customerAudioStarted: vi.fn().mockResolvedValue(undefined),
    customerPlaybackAcknowledged: vi.fn().mockResolvedValue(undefined),
    customerTermination: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
  } satisfies VoiceStore;
  const answer = vi
    .fn()
    .mockResolvedValue("The consultation costs fifty dollars.");
  const hangup = vi.fn().mockResolvedValue(undefined);
  const stopConnectingRingback = vi.fn().mockResolvedValue(undefined);
  const onStartupTiming = vi.fn();
  const call = new LiveCall({
    session,
    businessName: "Lakeview Plumbing",
    phone: phone.asWebSocket(),
    openaiKey: "test-key",
    profile,
    store,
    answer,
    hangup,
    onClosed: vi.fn(),
    stopConnectingRingback: connectingRingback
      ? stopConnectingRingback
      : undefined,
    onStartupTiming,
    connectOpenAI: () => live.asWebSocket(),
    monotonicNow: () => Date.now(),
    ...overrides,
  });
  async function start(delayAudio = false, acknowledgeGreeting = true) {
    const p = AUDIO_PROFILES[profile];
    phone.event({
      event: "start",
      stream_id: "stream",
      start: {
        call_control_id: session.call_control_id,
        call_session_id: session.call_session_id,
        from: session.caller_phone,
        to: session.called_phone,
        media_format: {
          encoding: p.encoding,
          sample_rate: p.rate,
          channels: 1,
        },
      },
    });
    live.emit("open");
    if (delayAudio) {
      const frame = Buffer.alloc(new AudioQueue(profile).frameBytes, 23);
      for (let chunk = 1; chunk <= 100; chunk++) {
        phone.event({
          event: "media",
          stream_id: "stream",
          media: {
            track: "inbound",
            chunk: String(chunk),
            payload: frame.toString("base64"),
          },
        });
        await vi.advanceTimersByTimeAsync(20);
      }
    }
    live.event({
      type: "session.started",
      session: { id: "openai-session", audio: { format: p.format } },
    });
    await vi.advanceTimersByTimeAsync(1);
    if (acknowledgeGreeting) {
      const greeting = live.sent.find(
        (e) => e.type === "session.instructions.append",
      );
      live.event({
        type: "session.instructions.appended",
        client_event_id: greeting?.event_id,
      });
    }
  }
  async function finish(reason = "caller_hangup") {
    const pending = call.close(reason, false);
    live.event({ type: "session.closed", usage: { seconds: 3 } });
    await pending;
  }
  return {
    phone,
    live,
    store,
    answer,
    hangup,
    call,
    start,
    finish,
    stopConnectingRingback,
    onStartupTiming,
  };
}

describe("continuous phone bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it.each(["pcm16", "pcmu8"] as const)(
    "meters commercial %s from the first audible frame and its own acknowledged mark",
    async (profile) => {
      const h = harness(profile, false, { session: { ...session, access_source: "commercial" } });
      await h.start(true);
      h.live.event({ type: "session.usage.updated", usage: { seconds: 20 } });
      const frameBytes = new AudioQueue(profile).frameBytes;
      h.live.event({ type: "session.output_audio.delta", delta: Buffer.alloc(frameBytes * 5, AUDIO_PROFILES[profile].silence).toString("base64") });
      await vi.advanceTimersByTimeAsync(120);
      expect(h.store.customerAudioStarted).not.toHaveBeenCalled();
      h.live.event({ type: "session.output_audio.delta", delta: Buffer.alloc(frameBytes, 23).toString("base64") });
      await vi.advanceTimersByTimeAsync(20);
      const mark = h.phone.sent.find((event) => event.event === "mark" && String((event.mark as { name: string }).name).startsWith("customer-start-"));
      const name = (mark?.mark as { name: string }).name;
      expect(name).toMatch(/^customer-start-/);
      expect(h.store.customerAudioStarted).toHaveBeenCalledWith(name, expect.any(String));
      expect(h.store.customerPlaybackAcknowledged).not.toHaveBeenCalled();
      h.phone.event({ event: "mark", stream_id: "wrong", mark: { name } });
      h.phone.event({ event: "mark", stream_id: "stream", mark: { name: "unrelated" } });
      await vi.advanceTimersByTimeAsync(1);
      expect(h.store.customerPlaybackAcknowledged).not.toHaveBeenCalled();
      h.phone.event({ event: "mark", stream_id: "stream", mark: { name } });
      h.phone.event({ event: "mark", stream_id: "stream", mark: { name } });
      await vi.advanceTimersByTimeAsync(1);
      expect(h.store.customerPlaybackAcknowledged).toHaveBeenCalledExactlyOnceWith(name);
      expect(h.store.customerAudioStarted.mock.invocationCallOrder[0]).toBeLessThan(h.store.customerPlaybackAcknowledged.mock.invocationCallOrder[0]);
      await h.finish();
    },
  );
  it("uses the commercial monotonic deadline and hangs up before provider close completes", async () => {
    let monotonic = 1000;
    const h = harness("pcm16", false, {
      session: { ...session, access_source: "commercial", reserved_seconds: 60 },
      monotonicNow: () => monotonic,
    });
    await h.start();
    h.live.event({ type: "session.output_audio.delta", delta: Buffer.alloc(new AudioQueue("pcm16").frameBytes, 23).toString("base64") });
    await vi.advanceTimersByTimeAsync(20);
    const name = (h.phone.sent.find((event) => event.event === "mark")?.mark as { name: string }).name;
    h.phone.event({ event: "mark", stream_id: "stream", mark: { name } });
    await vi.advanceTimersByTimeAsync(1);
    // Large provider elapsed usage and a wall-clock jump cannot consume the
    // separately reserved conversation time or trigger the old pilot cutoff.
    h.live.event({ type: "session.usage.updated", usage: { seconds: 500 } });
    vi.setSystemTime(Date.now() - 600000);
    monotonic += 30000;
    await vi.advanceTimersByTimeAsync(20);
    expect(h.live.sent.filter((e) => String(e.content).includes("thirty seconds"))).toHaveLength(1);
    expect(h.hangup).not.toHaveBeenCalled();
    monotonic += 30000;
    await vi.advanceTimersByTimeAsync(20);
    expect(h.hangup).toHaveBeenCalledOnce();
    expect(h.store.finish).not.toHaveBeenCalled();
    h.live.event({ type: "session.closed", usage: { seconds: 501 } });
    await h.call.done;
    expect(h.store.finish).toHaveBeenCalledWith("time_limit", null, false);
    expect(h.hangup).toHaveBeenCalledOnce();
  });
  it("keeps missing start acknowledgment unbillable and does not mistake stream stop for phone termination", async () => {
    const h = harness("pcm16", false, { session: { ...session, access_source: "commercial" } });
    await h.start();
    h.live.event({ type: "session.output_audio.delta", delta: Buffer.alloc(new AudioQueue("pcm16").frameBytes, 23).toString("base64") });
    await vi.advanceTimersByTimeAsync(10040);
    expect(h.store.customerAudioStarted).toHaveBeenCalledOnce();
    expect(h.store.customerPlaybackAcknowledged).not.toHaveBeenCalled();
    expect(h.hangup).toHaveBeenCalledOnce();
    h.phone.event({ event: "stop", stream_id: "stream" });
    h.live.event({ type: "session.closed", usage: { seconds: 13 } });
    await h.call.done;
    expect(h.store.customerTermination).not.toHaveBeenCalled();
    expect(h.store.finish).toHaveBeenCalledWith("customer_playback_unconfirmed", "customer_playback_unconfirmed", true);
  });
  it("adopts a prepared provider without starting another session", async () => {
    const preparedSocket = new Socket();
    const h = harness("pcm16", false, {
      prepared: {
        socket: preparedSocket.asWebSocket(),
        startedEvent: JSON.stringify({
          type: "session.started",
          session: {
            id: "prepared-id",
            audio: { format: AUDIO_PROFILES.pcm16.format },
          },
        }),
        startedAt: Date.now() - 11000,
        seconds: 11,
      },
    });
    await h.start();
    expect(h.store.activate).toHaveBeenCalledWith("prepared-id");
    expect(preparedSocket.sent.some((e) => e.type === "session.start")).toBe(
      false,
    );
    expect(
      preparedSocket.sent.filter(
        (e) => e.type === "session.instructions.append",
      ),
    ).toHaveLength(1);
    const done = h.call.close("caller_hangup", false);
    preparedSocket.event({ type: "session.closed", usage: { seconds: 12 } });
    await done;
    expect(h.store.usage).toHaveBeenCalledWith(12, true);
  });
  it("does not treat a proposed action or generated text as caller playback", async () => {
    const acknowledged = vi.fn().mockResolvedValue(undefined);
    const h = harness("pcm16", false, {
      actionsEnabled: true,
      acknowledgeActionPlayback: acknowledged,
    });
    await h.start();
    h.answer.mockResolvedValue({
      text: "May I text the signup link?",
      confirmationActionId: "action-id",
    });
    h.live.event({
      type: "session.input_transcript.delta",
      event_id: "request",
      delta: "Send the signup link",
      start_ms: 100,
      end_ms: 400,
    });
    h.live.event({
      type: "session.delegation.created",
      offset_ms: 400,
      delegation: { id: "delegate", target: "client" },
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(acknowledged).not.toHaveBeenCalled();
    h.live.event({
      type: "session.output_transcript.delta",
      event_id: "readback",
      delta: "May I text the signup link?",
      start_ms: 500,
      end_ms: 900,
    });
    h.live.event({
      type: "session.output_audio.delta",
      delta: Buffer.alloc(640, 17).toString("base64"),
    });
    await vi.advanceTimersByTimeAsync(240);
    const mark = h.phone.sent.find(
      (e) =>
        e.event === "mark" &&
        String((e.mark as { name: string }).name).startsWith("action-"),
    );
    expect(mark).toBeDefined();
    expect(acknowledged).not.toHaveBeenCalled();
    h.phone.event({ event: "mark", mark: mark?.mark });
    await vi.advanceTimersByTimeAsync(1);
    expect(acknowledged).toHaveBeenCalledWith("action-id", "readback", 400);
    // An unclear answer may legitimately require a new readback. It must
    // replace the playback evidence instead of remaining tied to the old one.
    h.live.event({
      type: "session.input_transcript.delta",
      event_id: "unclear",
      delta: "Maybe",
      start_ms: 1000,
      end_ms: 1200,
    });
    h.live.event({
      type: "session.delegation.created",
      offset_ms: 1200,
      delegation: { id: "repeat-permission", target: "client" },
    });
    await vi.advanceTimersByTimeAsync(300);
    h.live.event({
      type: "session.output_transcript.delta",
      event_id: "new-readback",
      delta: "May I text the signup link?",
      start_ms: 1500,
      end_ms: 1900,
    });
    h.live.event({
      type: "session.output_audio.delta",
      delta: Buffer.alloc(640, 17).toString("base64"),
    });
    await vi.advanceTimersByTimeAsync(240);
    const newMark = h.phone.sent
      .filter(
        (e) =>
          e.event === "mark" &&
          String((e.mark as { name: string }).name).startsWith("action-"),
      )
      .at(-1);
    expect(newMark?.mark).not.toEqual(mark?.mark);
    h.phone.event({ event: "mark", mark: newMark?.mark });
    await vi.advanceTimersByTimeAsync(1);
    expect(acknowledged).toHaveBeenLastCalledWith(
      "action-id",
      "new-readback",
      1200,
    );
    await h.finish();
  });
  async function prepareActionReadback(h: ReturnType<typeof harness>) {
    h.answer.mockResolvedValue({
      text: "May I text the signup link?",
      confirmationActionId: "action-id",
    });
    h.live.event({ type: "session.input_transcript.delta", event_id: "request", delta: "Send the signup link", start_ms: 100, end_ms: 400 });
    h.live.event({ type: "session.delegation.created", offset_ms: 400, delegation: { id: "proposal", target: "client" } });
    await vi.advanceTimersByTimeAsync(300);
    h.live.event({ type: "session.output_transcript.delta", event_id: "readback", delta: "May I text the signup link?", start_ms: 500, end_ms: 900 });
  }
  function actionPlaybackMarks(phone: Socket) {
    return phone.sent.filter((event) => event.event === "mark" && String((event.mark as { name: string }).name).startsWith("action-"));
  }
  function emitOutput(live: Socket, bytes: Buffer) {
    live.event({ type: "session.output_audio.delta", delta: bytes.toString("base64") });
  }
  it.each(["pcm16", "pcmu8"] as const)(
    "persists %s action playback despite continuous silence and supplies it to the next clear assent",
    async (profile) => {
      let releaseWrite!: () => void;
      const writeReady = new Promise<void>((resolve) => { releaseWrite = resolve; });
      let persistedPlayback: { actionId: string; eventId: string; callerEndMs: number } | null = null;
      const acknowledged = vi.fn(async (actionId: string, eventId: string, callerEndMs: number) => {
        await writeReady;
        persistedPlayback = { actionId, eventId, callerEndMs };
      });
      const h = harness(profile, false, { actionsEnabled: true, acknowledgeActionPlayback: acknowledged });
      await h.start();
      await prepareActionReadback(h);
      const frameBytes = new AudioQueue(profile).frameBytes;
      const speech = Buffer.alloc(frameBytes, 17);
      const silence = Buffer.alloc(frameBytes, AUDIO_PROFILES[profile].silence);
      // Provider stays 200 ms ahead of phone playback, even after its speech
      // ends. Appending one silent frame per paced tick never empties the queue.
      emitOutput(h.live, Buffer.concat([speech, ...Array<Buffer>(9).fill(silence)]));
      for (let frame = 1; frame <= 12; frame++) {
        emitOutput(h.live, silence);
        await vi.advanceTimersByTimeAsync(20);
        const sentFrames = h.phone.sent.filter((event) => event.event === "media").length;
        expect(10 + frame - sentFrames).toBe(10);
      }
      const marks = actionPlaybackMarks(h.phone);
      expect(marks).toHaveLength(1);
      expect(console.info).toHaveBeenCalledWith("[voice-playback] action_mark_queued", expect.objectContaining({ pendingAudioMs: 200 }));
      expect(acknowledged).not.toHaveBeenCalled();
      h.phone.event({ event: "mark", mark: marks[0].mark });
      await vi.advanceTimersByTimeAsync(1);
      expect(acknowledged).toHaveBeenCalledWith("action-id", "readback", 400);
      expect(persistedPlayback).toBeNull();

      let evidenceAtAnswer: unknown;
      h.answer.mockImplementationOnce(async (_session, _id, transcript) => {
        evidenceAtAnswer = { playback: persistedPlayback, callerReply: transcript.fragments.at(-1)?.text };
        return "The existing action can now be checked against the caller's reply.";
      });
      h.live.event({ type: "session.input_transcript.delta", event_id: "yes", delta: "Yes, please.", start_ms: 1000, end_ms: 1200 });
      h.live.event({ type: "session.delegation.created", offset_ms: 1200, delegation: { id: "confirmation", target: "client" } });
      await vi.advanceTimersByTimeAsync(300);
      // A queued transport acknowledgment alone is insufficient: delegation
      // waits for its durable write before reading the action state.
      expect(h.answer).toHaveBeenCalledTimes(1);
      releaseWrite();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.answer).toHaveBeenCalledTimes(2);
      expect(evidenceAtAnswer).toEqual({ playback: { actionId: "action-id", eventId: "readback", callerEndMs: 400 }, callerReply: "Yes, please." });
      expect(acknowledged).toHaveBeenCalledTimes(1);
      await h.finish();
    },
  );
  it.each([
    ["pcm16", "none"], ["pcmu8", "none"],
    ["pcm16", "silence"], ["pcmu8", "silence"],
  ] as const)("does not mark %s readback text with %s audio", async (profile, output) => {
    const acknowledged = vi.fn().mockResolvedValue(undefined);
    const h = harness(profile, false, { actionsEnabled: true, acknowledgeActionPlayback: acknowledged });
    await h.start();
    await prepareActionReadback(h);
    if (output === "silence") emitOutput(h.live, Buffer.alloc(new AudioQueue(profile).frameBytes * 10, AUDIO_PROFILES[profile].silence));
    await vi.advanceTimersByTimeAsync(500);
    expect(actionPlaybackMarks(h.phone)).toEqual([]);
    expect(acknowledged).not.toHaveBeenCalled();
    await h.finish();
  });
  it.each(["pcm16", "pcmu8"] as const)(
    "does not use %s audio received before the action was armed as new readback evidence",
    async (profile) => {
      const acknowledged = vi.fn().mockResolvedValue(undefined);
      const h = harness(profile, false, { actionsEnabled: true, acknowledgeActionPlayback: acknowledged });
      await h.start();
      const speech = Buffer.alloc(new AudioQueue(profile).frameBytes, 17);
      emitOutput(h.live, Buffer.concat(Array<Buffer>(25).fill(speech)));
      await prepareActionReadback(h);
      // Some old speech is sent after arming, but no new audible output has
      // arrived for this readback. Generated text must not authorize a mark.
      await vi.advanceTimersByTimeAsync(400);
      expect(actionPlaybackMarks(h.phone)).toEqual([]);
      expect(acknowledged).not.toHaveBeenCalled();
      emitOutput(h.live, speech);
      await vi.advanceTimersByTimeAsync(240);
      expect(actionPlaybackMarks(h.phone)).toHaveLength(1);
      expect(acknowledged).not.toHaveBeenCalled();
      await h.finish();
    },
  );
  it.each(["pcm16", "pcmu8"] as const)(
    "waits for a quiet %s audible tail hidden between silent frames before queuing the action mark",
    async (profile) => {
      const acknowledged = vi.fn().mockResolvedValue(undefined);
      const h = harness(profile, false, { actionsEnabled: true, acknowledgeActionPlayback: acknowledged });
      await h.start();
      await prepareActionReadback(h);
      const frameBytes = new AudioQueue(profile).frameBytes;
      const silence = Buffer.alloc(frameBytes, AUDIO_PROFILES[profile].silence);
      const quietTail = Buffer.alloc(frameBytes, 250);
      if (profile === "pcm16") for (let offset = 0; offset < frameBytes; offset += 2) quietTail.writeInt16LE(40, offset);
      const tailWithSilence = Buffer.concat([...Array<Buffer>(25).fill(silence), quietTail, ...Array<Buffer>(9).fill(silence)]);
      expect(hasAudibleAudio(quietTail, profile)).toBe(true);
      expect(hasAudibleAudio(tailWithSilence, profile)).toBe(false);
      emitOutput(h.live, Buffer.alloc(frameBytes, 17));
      emitOutput(h.live, tailWithSilence);
      await vi.advanceTimersByTimeAsync(300);
      expect(actionPlaybackMarks(h.phone)).toEqual([]);
      expect(acknowledged).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(280);
      const marks = actionPlaybackMarks(h.phone);
      expect(marks).toHaveLength(1);
      const tailSentIndex = h.phone.sent.findIndex((event) => event.event === "media" && (event.media as { payload: string }).payload === quietTail.toString("base64"));
      expect(tailSentIndex).toBeGreaterThanOrEqual(0);
      expect(h.phone.sent.indexOf(marks[0])).toBeGreaterThan(tailSentIndex);
      expect(acknowledged).not.toHaveBeenCalled();
      h.phone.event({ event: "mark", mark: marks[0].mark });
      await vi.advanceTimersByTimeAsync(1);
      expect(acknowledged).toHaveBeenCalledWith("action-id", "readback", 400);
      await h.finish();
    },
  );
  it.each([
    ["accepted", "playback_acknowledged", 400],
    ["caller_advanced", "caller_advanced", 1200],
    ["stale", "stale_action", 400],
    ["closing", "closing", 400],
  ] as const)(
    "logs only safe playback diagnostics when an action mark is %s",
    async (scenario, reason, latestCallerEndMs) => {
      const acknowledged = vi.fn().mockResolvedValue(undefined);
      const h = harness("pcm16", false, {
        actionsEnabled: true,
        acknowledgeActionPlayback: acknowledged,
      });
      await h.start();
      h.answer.mockResolvedValue({
        text: "May I save the caller's private contact details?",
        confirmationActionId: "action-id",
      });
      h.live.event({
        type: "session.input_transcript.delta",
        event_id: "private-request-event",
        delta: "My private email is person@example.com",
        start_ms: 100,
        end_ms: 400,
      });
      h.live.event({
        type: "session.delegation.created",
        offset_ms: 400,
        delegation: { id: "delegate", target: "client" },
      });
      await vi.advanceTimersByTimeAsync(300);
      h.live.event({
        type: "session.output_transcript.delta",
        event_id: "private-readback-event",
        delta: "May I save person@example.com?",
        start_ms: 500,
        end_ms: 900,
      });
      h.live.event({
        type: "session.output_audio.delta",
        delta: Buffer.alloc(640, 17).toString("base64"),
      });
      await vi.advanceTimersByTimeAsync(240);
      const mark = h.phone.sent.find(
        (event) =>
          event.event === "mark" &&
          String((event.mark as { name: string }).name).startsWith("action-"),
      );
      expect(mark).toBeDefined();

      if (scenario === "caller_advanced") {
        // The caller's assent arrives before the phone's delayed playback ack.
        // Keep the existing rejection, even though the readback was generated.
        h.live.event({
          type: "session.input_transcript.delta",
          event_id: "private-confirmation-event",
          delta: "Yes, save person@example.com",
          start_ms: 1000,
          end_ms: 1200,
        });
      } else if (scenario === "stale") {
        h.answer.mockResolvedValue({
          text: "May I confirm the replacement action?",
          confirmationActionId: "replacement-action",
        });
        h.live.event({
          type: "session.delegation.created",
          offset_ms: 400,
          delegation: { id: "replacement-delegate", target: "client" },
        });
        await vi.advanceTimersByTimeAsync(300);
      } else if (scenario === "closing") {
        void h.call.close("caller_hangup", false);
      }

      h.phone.event({ event: "mark", mark: mark?.mark });
      await vi.advanceTimersByTimeAsync(1);
      h.phone.event({ event: "mark", mark: mark?.mark });
      await vi.advanceTimersByTimeAsync(1);
      expect(acknowledged).toHaveBeenCalledTimes(scenario === "accepted" ? 1 : 0);
      if (scenario === "accepted")
        expect(acknowledged).toHaveBeenCalledWith(
          "action-id",
          "private-readback-event",
          400,
        );
      const diagnostics = vi.mocked(console.info).mock.calls.filter(
        ([message]) => message === "[voice-playback] action_mark_received",
      );
      // Exact keys also ensure no transcript, contact data, or provider IDs leak.
      expect(diagnostics).toEqual([
        [
          "[voice-playback] action_mark_received",
          {
            sessionId: session.id,
            actionId: "action-id",
            outcome: scenario === "accepted" ? "accepted" : "rejected",
            reason,
            callerEndMs: 400,
            latestCallerEndMs,
          },
        ],
      ]);
      await h.finish();
    },
  );
  it("opens once in Marin with the assigned business name and a single natural question", async () => {
    const h = harness();
    await h.start();
    const instructions = (h.live.sent[0].session as { instructions: string })
      .instructions;
    expect(instructions).toContain('"Lakeview Plumbing"');
    expect(instructions).toContain("Never pretend to be human");
    const openings = h.live.sent.filter(
      (e) => e.type === "session.instructions.append",
    );
    expect(openings).toHaveLength(1);
    expect(openings[0].content).toContain(
      "Hi, this is Lakeview Plumbing. How are you doing today?",
    );
    await vi.advanceTimersByTimeAsync(8100);
    expect(h.hangup).not.toHaveBeenCalled();
    await h.finish();
  });
  it("requires acknowledgment of the actual opening instruction", async () => {
    const h = harness();
    await h.start(false, false);
    h.live.event({
      type: "session.instructions.appended",
      client_event_id: "unrelated",
    });
    await vi.advanceTimersByTimeAsync(8100);
    h.live.event({ type: "session.closed", usage: { seconds: 8 } });
    await h.call.done;
    expect(h.store.finish).toHaveBeenCalledWith(
      "greeting_instruction_timeout",
      "greeting_instruction_timeout",
      true,
    );
  });
  it("nudges the greeting once, only after its instruction is acknowledged", async () => {
    const h = harness();
    await h.start(false, false);
    expect(
      h.live.sent.filter((e) => e.type === "session.commentary.append"),
    ).toEqual([]);
    const instruction = h.live.sent.find(
      (e) => e.type === "session.instructions.append",
    )!;
    for (let i = 0; i < 2; i++)
      h.live.event({
        type: "session.instructions.appended",
        client_event_id: instruction.event_id,
      });
    expect(
      h.live.sent.filter((e) => e.type === "session.commentary.append"),
    ).toHaveLength(1);
    await h.finish();
  });
  it.each(["pcm16", "pcmu8"] as const)(
    "keeps ringing through %s silence and preserves the opening while ring-stop is pending",
    async (profile) => {
      const h = harness(profile, true);
      await h.start();
      const bytes = new AudioQueue(profile).frameBytes;
      const silence = Buffer.alloc(bytes, AUDIO_PROFILES[profile].silence);
      const speech = Buffer.alloc(bytes, 17);
      const emit = (b: Buffer) =>
        h.live.event({
          type: "session.output_audio.delta",
          delta: b.toString("base64"),
        });
      for (let i = 0; i < 150; i++) {
        emit(silence);
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(h.stopConnectingRingback).not.toHaveBeenCalled();
      expect(h.phone.sent.filter((e) => e.event === "media")).toEqual([]);
      expect(h.store.audioSent).not.toHaveBeenCalled();
      let release!: () => void;
      h.stopConnectingRingback.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      emit(speech);
      await vi.advanceTimersByTimeAsync(20);
      for (let i = 0; i < 30; i++) {
        emit(speech);
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(h.stopConnectingRingback).toHaveBeenCalledOnce();
      expect(h.phone.sent.filter((e) => e.event === "media")).toEqual([]);
      release();
      await vi.advanceTimersByTimeAsync(800);
      const sent = h.phone.sent
        .filter((e) => e.event === "media")
        .map((e) =>
          Buffer.from(
            String((e.media as { payload: string }).payload),
            "base64",
          ),
        );
      expect(Buffer.concat(sent)).toEqual(
        Buffer.concat([...Array(5).fill(silence), ...Array(31).fill(speech)]),
      );
      expect(h.store.audioSent).toHaveBeenCalledOnce();
      expect(h.onStartupTiming.mock.calls.map((c) => c[0])).toEqual(
        expect.arrayContaining([
          "audible_opening_buffered",
          "ringback_stop_acknowledged",
          "first_audio_sent",
        ]),
      );
      await h.finish();
    },
  );
  it("does not replay late greeting audio after the caller hangs up during handoff", async () => {
    const h = harness("pcm16", true);
    await h.start();
    let release!: () => void;
    h.stopConnectingRingback.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.live.event({
      type: "session.output_audio.delta",
      delta: Buffer.alloc(640, 17).toString("base64"),
    });
    await vi.advanceTimersByTimeAsync(20);
    const closed = h.finish();
    release();
    await closed;
    await vi.advanceTimersByTimeAsync(100);
    expect(h.phone.sent.filter((e) => e.event === "media")).toEqual([]);
  });
  it("restores the shallow playback buffer after the opening handoff", async () => {
    const h = harness("pcm16", true);
    await h.start();
    h.live.event({
      type: "session.output_audio.delta",
      delta: Buffer.alloc(640, 17).toString("base64"),
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(h.store.audioSent).toHaveBeenCalledOnce();
    h.live.event({
      type: "session.output_audio.delta",
      delta: Buffer.alloc(640 * 80, 17).toString("base64"),
    });
    h.live.event({ type: "session.closed", usage: { seconds: 1 } });
    await h.call.done;
    expect(h.store.finish).toHaveBeenCalledWith(
      "audio_backpressure",
      "audio_backpressure",
      true,
    );
  });
  it.each(["failure", "timeout"])(
    "falls back on ring-stop %s without speaking over ringing",
    async (kind) => {
      const h = harness("pcm16", true);
      await h.start();
      if (kind === "failure")
        h.stopConnectingRingback.mockRejectedValueOnce(
          new Error("unavailable"),
        );
      else
        h.stopConnectingRingback.mockImplementationOnce(
          () => new Promise(() => {}),
        );
      h.live.event({
        type: "session.output_audio.delta",
        delta: Buffer.alloc(640, 17).toString("base64"),
      });
      await vi.advanceTimersByTimeAsync(2100);
      h.live.event({ type: "session.closed", usage: { seconds: 3 } });
      await h.call.done;
      const code =
        kind === "failure" ? "ringback_stop_failed" : "ringback_stop_timeout";
      expect(h.store.finish).toHaveBeenCalledWith(code, code, true);
      expect(h.phone.sent.filter((e) => e.event === "media")).toEqual([]);
    },
  );
  it("ends a silent provider startup even if the greeting instruction was acknowledged", async () => {
    const h = harness("pcm16", true);
    await h.start();
    await vi.advanceTimersByTimeAsync(12001);
    h.live.event({ type: "session.closed", usage: { seconds: 12 } });
    await h.call.done;
    expect(h.store.finish).toHaveBeenCalledWith(
      "greeting_audio_timeout",
      "greeting_audio_timeout",
      true,
    );
    expect(h.stopConnectingRingback).not.toHaveBeenCalled();
  });
  it.each(["pcm16", "pcmu8"] as const)(
    "carries %s audio in both directions using the stable client-delegation API",
    async (profile) => {
      const h = harness(profile);
      await h.start();
      expect(h.live.sent[0]).toMatchObject({
        type: "session.start",
        session: {
          model: "gpt-live-1",
          audio: {
            format: AUDIO_PROFILES[profile].format,
            output: { voice: "marin" },
          },
          delegation: { type: "client" },
          store: false,
        },
      });
      const frame = Buffer.alloc(new AudioQueue(profile).frameBytes, 17);
      h.phone.event({
        event: "media",
        stream_id: "stream",
        media: {
          track: "inbound",
          chunk: "1",
          payload: frame.toString("base64"),
        },
      });
      h.live.event({
        type: "session.output_audio.delta",
        delta: frame.toString("base64"),
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(h.live.sent).toContainEqual(
        expect.objectContaining({
          type: "session.input_audio.append",
          audio: frame.toString("base64"),
        }),
      );
      expect(h.phone.sent).toContainEqual({
        event: "media",
        media: { payload: frame.toString("base64") },
      });
      expect(h.store.audioSent).toHaveBeenCalledOnce();
      expect(h.store.playbackAcknowledged).not.toHaveBeenCalled();
      await h.finish();
      expect(h.store.usage).toHaveBeenLastCalledWith(3, true);
      expect(h.store.finish).toHaveBeenCalledWith("caller_hangup", null, false);
    },
  );
  it("preserves caller speech across a two-second provider startup without filling the jitter buffer", async () => {
    const h = harness();
    await h.start(true);
    const appends = h.live.sent.filter(
      (e) => e.type === "session.input_audio.append",
    );
    expect(appends).toHaveLength(1);
    expect(Buffer.from(String(appends[0].audio), "base64")).toEqual(
      Buffer.alloc(new AudioQueue("pcm16").frameBytes * 100, 23),
    );
    expect(h.store.finish).not.toHaveBeenCalled();
    await h.finish();
  });
  it("answers a delegated question from current-call transcript and deduplicates events", async () => {
    const h = harness();
    await h.start();
    const fragment = {
      type: "session.input_transcript.delta",
      event_id: "f",
      delta: "What does a consultation cost?",
      start_ms: 0,
      end_ms: 1000,
    };
    h.live.event(fragment);
    h.live.event(fragment);
    const delegation = {
      type: "session.delegation.created",
      offset_ms: 1000,
      delegation: { id: "d", target: "client" },
    };
    h.live.event(delegation);
    h.live.event(delegation);
    await vi.advanceTimersByTimeAsync(251);
    expect(h.answer).toHaveBeenCalledOnce();
    expect(h.answer.mock.calls[0][2].text).toContain(
      "What does a consultation cost?",
    );
    expect(h.store.fragment).toHaveBeenCalledOnce();
    expect(h.live.sent).toContainEqual(
      expect.objectContaining({
        type: "session.commentary.append",
        delegation_id: "d",
        content: "The consultation costs fifty dollars.",
      }),
    );
    expect(h.store.playbackAcknowledged).not.toHaveBeenCalled();
    await h.finish();
  });
  it("suppresses an obsolete answer after the caller corrects the question", async () => {
    const h = harness();
    await h.start();
    let resolve!: (answer: string) => void;
    h.answer.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    h.live.event({
      type: "session.input_transcript.delta",
      event_id: "f",
      delta: "How much?",
      start_ms: 0,
      end_ms: 1000,
    });
    h.live.event({
      type: "session.delegation.created",
      offset_ms: 1000,
      delegation: { id: "d", target: "client" },
    });
    await vi.advanceTimersByTimeAsync(251);
    h.live.event({
      type: "session.input_transcript.delta",
      event_id: "correction",
      delta: "Actually I mean your hours",
      start_ms: 1100,
      end_ms: 2000,
    });
    resolve("OBSOLETE PRICE");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.live.sent.some((e) => e.content === "OBSOLETE PRICE")).toBe(false);
    expect(
      h.live.sent.some(
        (e) =>
          e.delegation_id === "d" &&
          typeof e.content === "string" &&
          e.content.includes("obsolete"),
      ),
    ).toBe(true);
    await h.finish();
  });
  it("captures the caller boundary with all persisted fragments after queued writes drain", async () => {
    const h = harness("pcm16", false, { actionsEnabled: true });
    await h.start();
    let persistFirst!: () => void;
    let persistSecond!: () => void;
    h.store.fragment
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (persistFirst = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (persistSecond = resolve)),
      );
    h.answer.mockResolvedValue({ text: "Your details were saved." });
    h.live.event({
      type: "session.input_transcript.delta",
      event_id: "confirmation-start",
      delta: "Yes, you can",
      start_ms: 0,
      end_ms: 1000,
    });
    h.live.event({
      type: "session.delegation.created",
      offset_ms: 1000,
      delegation: { id: "save-details", target: "client" },
    });
    await vi.advanceTimersByTimeAsync(251);
    expect(h.answer).not.toHaveBeenCalled();
    h.live.event({
      type: "session.input_transcript.delta",
      event_id: "confirmation-end",
      delta: " save those details.",
      start_ms: 1000,
      end_ms: 1600,
    });
    persistFirst();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.store.fragment).toHaveBeenCalledTimes(2);
    expect(h.answer).not.toHaveBeenCalled();
    persistSecond();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.answer).toHaveBeenCalledOnce();
    expect(h.answer.mock.calls[0][2].fragments).toHaveLength(2);
    expect(h.live.sent).toContainEqual(
      expect.objectContaining({
        delegation_id: "save-details",
        content: "Your details were saved.",
      }),
    );
    expect(console.info).toHaveBeenCalledWith(
      "[voice-delegation] delegate_started",
      expect.objectContaining({
        sessionId: "call",
        delegationId: "save-details",
        fragmentCount: 2,
        callerEndMs: 1600,
      }),
    );
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
      "save those details",
    );
    await h.finish();
  });
  it.each([
    ["below the delegation offset", 1100, 1400],
    ["older than the captured caller boundary", 500, 800],
  ] as const)(
    "requires fresh evaluation when a new caller fragment ends %s",
    async (_case, startMs, endMs) => {
      const h = harness("pcm16", false, { actionsEnabled: true });
      await h.start();
      let resolve!: (result: string) => void;
      h.answer.mockImplementationOnce(
        () => new Promise<string>((r) => (resolve = r)),
      );
      h.live.event({
        type: "session.input_transcript.delta",
        event_id: "initial-confirmation",
        delta: "Yes.",
        start_ms: 0,
        end_ms: 1000,
      });
      h.live.event({
        type: "session.delegation.created",
        offset_ms: 2000,
        delegation: { id: "initial", target: "client" },
      });
      await vi.advanceTimersByTimeAsync(251);
      h.live.event({
        type: "session.input_transcript.delta",
        event_id: "late-correction",
        delta: "But use my other email.",
        start_ms: startMs,
        end_ms: endMs,
      });
      resolve("OUTDATED RESULT");
      await vi.advanceTimersByTimeAsync(1);
      expect(h.answer).toHaveBeenCalledOnce();
      expect(h.live.sent.some((e) => e.content === "OUTDATED RESULT")).toBe(
        false,
      );
      expect(h.live.sent).toContainEqual(
        expect.objectContaining({
          delegation_id: "initial",
          content: expect.stringContaining(
            "Delegate the caller's complete latest reply",
          ),
        }),
      );
      expect(console.info).toHaveBeenCalledWith(
        "[voice-delegation] result_discarded",
        expect.objectContaining({ delegationId: "initial" }),
      );
      h.answer.mockResolvedValue("Please provide the corrected email.");
      h.live.event({
        type: "session.delegation.created",
        offset_ms: 2000,
        delegation: { id: "fresh", target: "client" },
      });
      await vi.advanceTimersByTimeAsync(251);
      expect(h.answer).toHaveBeenCalledTimes(2);
      expect(h.answer.mock.calls[1][2].fragments).toContainEqual(
        expect.objectContaining({ eventId: "late-correction" }),
      );
      expect(h.live.sent).toContainEqual(
        expect.objectContaining({
          delegation_id: "fresh",
          content: "Please provide the corrected email.",
        }),
      );
      await h.finish();
    },
  );
  it("does not start a superseded delegation after its persistence wait finishes", async () => {
    const h = harness();
    await h.start();
    let persist!: () => void;
    h.store.fragment.mockImplementationOnce(
      () => new Promise<void>((resolve) => (persist = resolve)),
    );
    h.live.event({
      type: "session.input_transcript.delta",
      event_id: "caller",
      delta: "Please save my details.",
      start_ms: 0,
      end_ms: 1000,
    });
    for (const id of ["old", "current"]) {
      h.live.event({
        type: "session.delegation.created",
        offset_ms: 1000,
        delegation: { id, target: "client" },
      });
      await vi.advanceTimersByTimeAsync(251);
    }
    persist();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.answer).toHaveBeenCalledOnce();
    expect(h.answer.mock.calls[0][1]).toBe("current");
    expect(console.info).toHaveBeenCalledWith(
      "[voice-delegation] superseded",
      expect.objectContaining({ delegationId: "old" }),
    );
    await h.finish();
  });
  it.each(["deadline", "closed"])(
    "does not start a delegation after its persistence wait is stopped by %s",
    async (reason) => {
      const h = harness("pcm16", false, { actionsEnabled: true });
      await h.start();
      let persist!: () => void;
      h.store.fragment.mockImplementationOnce(
        () => new Promise<void>((resolve) => (persist = resolve)),
      );
      h.live.event({
        type: "session.input_transcript.delta",
        event_id: "caller",
        delta: "Please save my details.",
        start_ms: 0,
        end_ms: 1000,
      });
      h.live.event({
        type: "session.delegation.created",
        offset_ms: 1000,
        delegation: { id: "waiting", target: "client" },
      });
      await vi.advanceTimersByTimeAsync(251);
      const finished = reason === "closed" ? h.finish() : null;
      if (reason === "deadline") {
        await vi.advanceTimersByTimeAsync(35001);
        expect(console.info).toHaveBeenCalledWith(
          "[voice-delegation] backend_failed",
          expect.objectContaining({ delegationId: "waiting" }),
        );
      }
      persist();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.answer).not.toHaveBeenCalled();
      if (finished) await finished;
      else await h.finish();
    },
  );
  it.each(["result", "stale"])(
    "nudges a silent %s response once without running another backend request",
    async (kind) => {
      const h = harness("pcm16", false, { actionsEnabled: true });
      await h.start();
      let resolve!: (result: string) => void;
      h.answer.mockImplementationOnce(
        () => new Promise<string>((r) => (resolve = r)),
      );
      h.live.event({
        type: "session.input_transcript.delta",
        event_id: "confirmation",
        delta: "Yes, please save those details.",
        start_ms: 0,
        end_ms: 1000,
      });
      h.live.event({
        type: "session.delegation.created",
        offset_ms: 1000,
        delegation: { id: "save-details", target: "client" },
      });
      await vi.advanceTimersByTimeAsync(251);
      if (kind === "stale")
        h.live.event({
          type: "session.input_transcript.delta",
          event_id: "late-fragment",
          delta: " please.",
          start_ms: 1000,
          end_ms: 1200,
        });
      resolve("The details were saved.");
      await vi.advanceTimersByTimeAsync(1);
      if (kind === "stale")
        expect(h.live.sent).toContainEqual(
          expect.objectContaining({
            delegation_id: "save-details",
            content: expect.stringContaining(
              "Preserve the existing task and current action state",
            ),
          }),
        );
      await vi.advanceTimersByTimeAsync(5001);
      const nudges = () =>
        h.live.sent.filter(
          (e) =>
            e.delegation_id === "save-details" &&
            typeof e.content === "string" &&
            e.content.startsWith("Continue "),
        );
      expect(nudges()).toHaveLength(1);
      expect(nudges()[0].content).toContain(
        kind === "stale"
          ? "current action ledger"
          : "Do not rerun a backend action",
      );
      await vi.advanceTimersByTimeAsync(6000);
      expect(nudges()).toHaveLength(1);
      expect(h.answer).toHaveBeenCalledOnce();
      await h.finish();
    },
  );
  it.each(["audio", "caller", "delegation", "closed"])(
    "cancels a result's silence nudge after new %s activity",
    async (activity) => {
      const h = harness("pcm16", false, { actionsEnabled: true });
      await h.start();
      h.live.event({
        type: "session.input_transcript.delta",
        event_id: "caller",
        delta: "Please save those details.",
        start_ms: 0,
        end_ms: 1000,
      });
      h.live.event({
        type: "session.delegation.created",
        offset_ms: 1000,
        delegation: { id: "first", target: "client" },
      });
      await vi.advanceTimersByTimeAsync(4000);
      if (activity === "audio")
        h.live.event({
          type: "session.output_audio.delta",
          delta: Buffer.alloc(640, 17).toString("base64"),
        });
      else if (activity === "caller")
        h.live.event({
          type: "session.input_transcript.delta",
          event_id: "new-caller-fragment",
          delta: "Thank you.",
          // Even an out-of-order fragment cancels the conversational nudge.
          start_ms: 600,
          end_ms: 900,
        });
      else if (activity === "delegation")
        h.live.event({
          type: "session.delegation.created",
          offset_ms: 1000,
          delegation: { id: "next", target: "client" },
        });
      else await h.finish();
      await vi.advanceTimersByTimeAsync(1500);
      expect(
        h.live.sent.some(
          (e) =>
            e.delegation_id === "first" &&
            typeof e.content === "string" &&
            e.content.startsWith("Continue "),
        ),
      ).toBe(false);
      if (activity !== "closed") await h.finish();
    },
  );
  it("retains cumulative usage without summing snapshots and marks a missing final result unconfirmed", async () => {
    const h = harness();
    await h.start();
    for (const seconds of [5, 5, 3, 7])
      h.live.event({ type: "session.usage.updated", usage: { seconds } });
    const pending = h.call.close("worker_shutdown", true);
    await vi.advanceTimersByTimeAsync(15001);
    await pending;
    expect(h.store.usage).toHaveBeenLastCalledWith(7, false);
    expect(h.store.finish).toHaveBeenCalledWith(
      "worker_shutdown",
      "worker_shutdown",
      true,
    );
  });
  it("keeps listening after bounded backend waits without replaying a failed request", async () => {
    const h = harness();
    await h.start();
    h.answer.mockImplementation(() => new Promise(() => {}));
    h.live.event({
      type: "session.input_transcript.delta",
      event_id: "f",
      delta: "Hours?",
      start_ms: 0,
      end_ms: 1000,
    });
    h.live.event({
      type: "session.delegation.created",
      offset_ms: 1000,
      delegation: { id: "d", target: "client" },
    });
    await vi.advanceTimersByTimeAsync(9251);
    expect(h.live.sent.some((e) => e.type === "session.close")).toBe(false);
    expect(h.live.sent).toContainEqual(
      expect.objectContaining({
        delegation_id: "d",
        content: expect.stringContaining("did not return a verified result"),
      }),
    );
    expect(h.hangup).not.toHaveBeenCalled();
    expect(h.answer).toHaveBeenCalledOnce();
    await h.finish();
  });
  it("recovers from action failures on a caller-requested retry without hanging up", async () => {
    const h = harness("pcm16", false, { actionsEnabled: true });
    await h.start();
    h.answer.mockRejectedValueOnce(new Error("invalid decision"));
    for (const [n, text] of [
      [1, "Correct"],
      [2, "Please check again"],
    ] as const) {
      h.live.event({
        type: "session.input_transcript.delta",
        event_id: `f${n}`,
        delta: text,
        start_ms: n * 1000,
        end_ms: n * 1000 + 500,
      });
      h.live.event({
        type: "session.delegation.created",
        offset_ms: n * 1000 + 500,
        delegation: { id: `d${n}`, target: "client" },
      });
      await vi.advanceTimersByTimeAsync(251);
    }
    expect(h.answer).toHaveBeenCalledTimes(2);
    expect(h.hangup).not.toHaveBeenCalled();
    expect(h.live.sent).toContainEqual(
      expect.objectContaining({
        delegation_id: "d1",
        content: expect.stringContaining(
          "Do not repeat the operation automatically",
        ),
      }),
    );
    expect(h.live.sent).toContainEqual(
      expect.objectContaining({
        delegation_id: "d2",
        content: "The consultation costs fifty dollars.",
      }),
    );
    await h.finish();
  });
  it("bounds repeated backend failures without an automatic send or abrupt hangup", async () => {
    const h = harness("pcm16", false, { actionsEnabled: true });
    await h.start();
    h.answer.mockRejectedValue(new Error("unavailable"));
    for (let n = 1; n <= 4; n++) {
      h.live.event({
        type: "session.input_transcript.delta",
        event_id: `f${n}`,
        delta: "Please check again",
        start_ms: n * 1000,
        end_ms: n * 1000 + 500,
      });
      h.live.event({
        type: "session.delegation.created",
        offset_ms: n * 1000 + 500,
        delegation: { id: `d${n}`, target: "client" },
      });
      await vi.advanceTimersByTimeAsync(251);
    }
    expect(h.answer).toHaveBeenCalledTimes(3);
    expect(h.hangup).not.toHaveBeenCalled();
    expect(h.live.sent).toContainEqual(
      expect.objectContaining({
        delegation_id: "d4",
        content: expect.stringContaining("unavailable for this call"),
      }),
    );
    await h.finish();
  });
  it("rejects media for a different stored call before connecting OpenAI", async () => {
    const h = harness();
    h.phone.event({
      event: "start",
      stream_id: "wrong",
      start: { call_control_id: "other" },
    });
    await h.call.done;
    expect(h.live.sent).toEqual([]);
    expect(h.store.finish).toHaveBeenCalledWith(
      "stream_identity_mismatch",
      "stream_identity_mismatch",
      true,
    );
  });
  it("enforces an operational stop during a call", async () => {
    const h = harness();
    await h.start();
    h.store.heartbeat.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(3000);
    h.live.event({ type: "session.closed", usage: { seconds: 3 } });
    await h.call.done;
    expect(h.store.finish).toHaveBeenCalledWith(
      "operational_stop",
      null,
      false,
    );
  });
});

describe("audio and transcript ordering", () => {
  it("distinguishes PCM and both PCMU silence encodings from quiet speech", () => {
    expect(hasAudibleAudio(Buffer.alloc(640), "pcm16")).toBe(false);
    expect(hasAudibleAudio(Buffer.alloc(160, 255), "pcmu8")).toBe(false);
    expect(hasAudibleAudio(Buffer.alloc(160, 127), "pcmu8")).toBe(false);
    const quiet = Buffer.alloc(640);
    for (let i = 0; i < 640; i += 2) quiet.writeInt16LE(40, i);
    expect(hasAudibleAudio(quiet, "pcm16")).toBe(true);
    expect(hasAudibleAudio(Buffer.alloc(160, 200), "pcmu8")).toBe(true);
  });
  it("reorders packets, drops duplicates and advances after a lost packet", () => {
    const q = new InboundReorderBuffer();
    q.add(2, Buffer.from([2]), 0);
    expect(q.drain(20)).toEqual([]);
    q.add(1, Buffer.from([1]), 21);
    q.add(2, Buffer.from([99]), 22);
    expect(q.drain(22).map((b) => b[0])).toEqual([1, 2]);
    q.add(4, Buffer.from([4]), 30);
    expect(q.drain(90).map((b) => b[0])).toEqual([4]);
    q.add(1, Buffer.from([1]), 100);
    expect(q.drain(200)).toEqual([]);
  });
  it("rejects unnegotiated formats and unbounded playback queues", () => {
    expect(() =>
      validateMediaFormat("pcm16", {
        encoding: "L16",
        sample_rate: 8000,
        channels: 1,
      }),
    ).toThrow("audio_format_mismatch");
    expect(() => new AudioQueue("pcm16").append(Buffer.alloc(100000))).toThrow(
      "audio_backpressure",
    );
    expect(new AudioQueue("pcmu8").take(true)?.every((b) => b === 255)).toBe(
      true,
    );
  });
  it("keeps late and overlapping transcript fragments without inventing completed turns", () => {
    const t = new CallTranscript();
    t.add({
      eventId: "b",
      role: "customer",
      text: "correction",
      startMs: 500,
      endMs: 1000,
    });
    t.add({
      eventId: "a",
      role: "assistant",
      text: "previous speech",
      startMs: 0,
      endMs: 700,
    });
    expect(t.snapshot().indexOf("previous speech")).toBeLessThan(
      t.snapshot().indexOf("correction"),
    );
    expect(t.latestCallerEndMs).toBe(1000);
  });
});


describe("public same-Marin disclosure", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const publicSession = { ...session, access_source: "commercial", disclosure_version: 1 } as VoiceSession;
  const notice = "Hi, thanks for calling Lakeview Plumbing. I’m the AI assistant, and this call will be recorded.";
  function setup(profile: "pcm16" | "pcmu8" = "pcm16", extra: Partial<LiveSessionOptions> = {}) {
    const startRecording = vi.fn().mockResolvedValue(undefined);
    const stopRecording = vi.fn().mockResolvedValue(undefined);
    const classifyDisclosureReply = vi.fn().mockResolvedValue("repeat");
    return { ...harness(profile, true, { session: publicSession, startRecording, stopRecording, classifyDisclosureReply, ...extra }),
      startRecording, stopRecording, classifyDisclosureReply };
  }
  async function sayNotice(f: ReturnType<typeof setup>, profile: "pcm16" | "pcmu8" = "pcm16", text = notice) {
    f.live.event({ type: "session.output_transcript.delta", event_id: `notice-${Math.random()}`, delta: text, start_ms: 0, end_ms: 200 });
    f.live.event({ type: "session.output_audio.delta", delta: Buffer.alloc(new AudioQueue(profile).frameBytes * 5, 23).toString("base64") });
    await vi.advanceTimersByTimeAsync(500);
    return (f.phone.sent.filter((e) => e.event === "mark" && String((e.mark as { name?: string } | undefined)?.name).startsWith("notice-")).at(-1)?.mark as { name: string } | undefined)?.name;
  }
  async function completePhoneOpening(f: ReturnType<typeof setup>, profile: "pcm16" | "pcmu8" = "pcm16") {
    const noticeMark = await sayNotice(f, profile);
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: noticeMark } });
    await vi.advanceTimersByTimeAsync(1);
    const handoff = (f.phone.sent.find((e) => e.event === "mark" && String((e.mark as { name?: string } | undefined)?.name).startsWith("handoff-"))?.mark as { name: string }).name;
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: handoff } });
    await vi.advanceTimersByTimeAsync(30);
  }
  it.each(["pcm16", "pcmu8"] as const)("keeps the full policy at startup and rejects oversized runtime appends through public handoff (%s)", async (profile) => {
    const f = setup(profile, { actionsEnabled: true });
    f.live.appendByteLimit = 500;
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    await f.start();
    const instructions = (f.live.sent.find((e) => e.type === "session.start")?.session as { instructions: string }).instructions;
    expect(Buffer.byteLength(instructions, "utf8")).toBeGreaterThan(500);
    expect(instructions).toContain(VOICE_RECEPTIONIST_FLOW);
    expect(instructions).toContain("normal conversation instructions below apply only after that activation");
    expect(instructions).toContain("The caller has not yet heard the AI and recording notice");
    expect(instructions).not.toContain("The caller has already heard");
    await completePhoneOpening(f, profile);
    const activation = f.live.sent.filter((e) => e.type === "session.instructions.append").at(-1)!;
    expect(activation.content).toContain("The conversation is now active");
    expect(activation.content).not.toContain(VOICE_RECEPTIONIST_FLOW);
    for (const e of f.live.sent.filter((e) => ["session.instructions.append", "session.commentary.append"].includes(String(e.type))))
      expect(Buffer.byteLength(e.content as string, "utf8")).toBeLessThanOrEqual(500);
    expect(f.hangup).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    const firstQuestion = () => f.live.sent.filter((e) => e.type === "session.commentary.append" && e.content === "Continue with the first question now.");
    expect(firstQuestion()).toHaveLength(0);
    f.live.event({ type: "session.instructions.appended", client_event_id: "unrelated" });
    f.live.event({ type: "session.instructions.appended", client_event_id: f.live.sent.find((e) => e.type === "session.instructions.append")?.event_id });
    expect(firstQuestion()).toHaveLength(0);
    f.live.event({ type: "session.instructions.appended", client_event_id: activation.event_id });
    f.live.event({ type: "session.instructions.appended", client_event_id: activation.event_id });
    expect(firstQuestion()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8050);
    expect(f.hangup).not.toHaveBeenCalled();
    await f.finish();
  });
  it("closes within the activation acknowledgment bound without an unacknowledged first-question nudge", async () => {
    const f = setup(); await f.start(); await completePhoneOpening(f);
    const activation = f.live.sent.filter((e) => e.type === "session.instructions.append").at(-1)!;
    await vi.advanceTimersByTimeAsync(8050);
    expect(f.hangup).toHaveBeenCalledOnce();
    f.live.event({ type: "session.instructions.appended", client_event_id: activation.event_id });
    expect(f.live.sent.some((e) => e.type === "session.commentary.append" && e.content === "Continue with the first question now.")).toBe(false);
    await f.finish();
    expect(f.store.finish).toHaveBeenCalledWith("activation_instruction_timeout", "activation_instruction_timeout", true);
  });
  it("logs only bounded protocol metadata, excluding provider messages and caller content", async () => {
    const f = setup(); const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await f.start(); await completePhoneOpening(f);
    const activation = f.live.sent.filter((e) => e.type === "session.instructions.append").at(-1)!;
    f.live.event({ type: "error", client_event_id: "irrelevant-top-level", error: {
      code: "content_too_long", type: "invalid_request_error", param: "content",
      client_event_id: activation.event_id, message: "Private caller words and user@example.com", content: "Private business instructions",
    } });
    expect(warn).toHaveBeenCalledExactlyOnceWith("[voice] provider_protocol_error", {
      sessionId: "call", code: "content_too_long", type: "invalid_request_error", param: "content", client_event_id: activation.event_id,
    });
    await f.finish();
    expect(f.store.finish).toHaveBeenCalledWith("openai_protocol_error", "openai_protocol_error", true);
  });
  it("omits malformed diagnostic fields instead of logging reflected private text", async () => {
    const f = setup(); const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); await f.start();
    f.live.event({ type: "error", error: {
      code: "caller words", type: "x".repeat(81), param: "customer@example.com", client_event_id: "private caller words", message: "do not log me",
    } });
    expect(warn).toHaveBeenCalledExactlyOnceWith("[voice] provider_protocol_error", {
      sessionId: "call", code: null, type: null, param: null, client_event_id: null,
    });
    await f.finish();
  });
  for (const profile of ["pcm16", "pcmu8"] as const) it(`records only after complete audible notice and starts minutes at acknowledged handoff (${profile})`, async () => {
    const f = setup(profile);
    await f.start();
    expect(f.store.beginDisclosure).toHaveBeenCalledWith("openai-session");
    expect(f.store.activate).not.toHaveBeenCalled();
    f.live.event({ type: "session.delegation.created", delegation: { id: "premature", target: "client" }, offset_ms: 0 });
    const mark = await sayNotice(f, profile);
    expect(mark).toBeTruthy();
    expect(f.answer).not.toHaveBeenCalled();
    expect(f.store.fragment).not.toHaveBeenCalled();
    expect(f.startRecording).not.toHaveBeenCalled();
    expect(f.store.customerAudioStarted).not.toHaveBeenCalled();
    f.phone.event({ event: "mark", stream_id: "other", mark: { name: mark } });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.startRecording).not.toHaveBeenCalled();
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: mark } });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.completeDisclosure).toHaveBeenCalledWith(mark);
    expect(f.startRecording).toHaveBeenCalledOnce();
    expect(f.store.recordingStarted).toHaveBeenCalledOnce();
    const handoff = (f.phone.sent.find((e) => e.event === "mark" && String((e.mark as { name?: string } | undefined)?.name).startsWith("handoff-"))?.mark as { name: string }).name;
    expect(f.store.handoffStarted).not.toHaveBeenCalled();
    expect(f.store.handoffAcknowledged).not.toHaveBeenCalled();
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: handoff } });
    await vi.advanceTimersByTimeAsync(30);
    expect(f.store.handoffStarted).toHaveBeenCalledWith(handoff, expect.any(String));
    expect(f.store.handoffAcknowledged).toHaveBeenCalledWith(handoff, expect.any(Number));
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: mark } });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.startRecording).toHaveBeenCalledOnce();
    f.live.event({ type: "session.input_transcript.delta", event_id: "late-private", delta: "early private words", start_ms: 0, end_ms: 20 });
    f.live.event({ type: "session.input_transcript.delta", event_id: "after-handoff", delta: "What are your hours?", start_ms: 3000, end_ms: 3500 });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.fragment).toHaveBeenCalledTimes(1);
    expect(f.store.fragment).toHaveBeenCalledWith(expect.objectContaining({ eventId: "after-handoff" }));
    expect(f.live.sent.some((e) => String(e.content).includes("How can I help you today?"))).toBe(true);
    await f.finish();
  });
  it("cannot start recording from transcript-only, silence, truncated text or wrong mark", async () => {
    const f = setup(); await f.start();
    f.live.event({ type: "session.output_transcript.delta", event_id: "text-only", delta: notice, start_ms: 0, end_ms: 100 });
    f.live.event({ type: "session.output_audio.delta", delta: Buffer.alloc(new AudioQueue("pcm16").frameBytes * 10).toString("base64") });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.phone.sent.filter((e) => e.event === "mark" && String((e.mark as { name?: string } | undefined)?.name).startsWith("notice-"))).toHaveLength(0);
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: "notice-1-invented" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.startRecording).not.toHaveBeenCalled();
    await f.finish();
    const g = setup(); await g.start(); await sayNotice(g, "pcm16", "Hi, thanks for calling Lakeview Plumbing.");
    expect(g.phone.sent.filter((e) => e.event === "mark" && String((e.mark as { name?: string } | undefined)?.name).startsWith("notice-"))).toHaveLength(0);
    await g.finish();
  });
  it("invalidates a cleared notice mark on interruption and permits only one complete replay", async () => {
    const f = setup(); await f.start(); const stale = await sayNotice(f);
    // A newly arrived audible tail invalidates the earlier drained-output mark.
    f.live.event({ type: "session.output_audio.delta", delta: Buffer.alloc(new AudioQueue("pcm16").frameBytes * 15, 23).toString("base64") });
    f.live.event({ type: "session.input_transcript.delta", event_id: "interrupt-tail", delta: "Hello?", start_ms: 400, end_ms: 600 });
    f.phone.event({ event: "media", stream_id: "stream", media: { track: "inbound", chunk: "1", payload: Buffer.alloc(new AudioQueue("pcm16").frameBytes, 23).toString("base64") } });
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: stale } });
    f.live.event({ type: "session.input_transcript.delta", event_id: "hello", delta: "Hello?", start_ms: 400, end_ms: 600 });
    await vi.advanceTimersByTimeAsync(850);
    expect(f.startRecording).not.toHaveBeenCalled();
    expect(f.classifyDisclosureReply).toHaveBeenCalledOnce();
    const retry = f.live.sent.filter((e) => e.type === "session.instructions.append").at(-1);
    f.live.event({ type: "session.instructions.appended", client_event_id: retry?.event_id });
    f.live.event({ type: "session.output_transcript.delta", event_id: "retry-start", delta: "Hi, thanks for calling", start_ms: 1000, end_ms: 1200 });
    f.live.event({ type: "session.output_audio.delta", delta: Buffer.alloc(new AudioQueue("pcm16").frameBytes * 15, 23).toString("base64") });
    f.live.event({ type: "session.input_transcript.delta", event_id: "interrupt-again", delta: "Hello again", start_ms: 1500, end_ms: 1600 });
    await vi.advanceTimersByTimeAsync(850);
    expect(f.hangup).toHaveBeenCalledOnce();
    expect(f.startRecording).not.toHaveBeenCalled();
    expect(f.store.fragment).not.toHaveBeenCalled();
    await f.finish();
  });
  it("closes on a recording refusal without saving the reply or calling business tools", async () => {
    const f = setup(); f.classifyDisclosureReply.mockResolvedValue("refuse"); await f.start();
    f.live.event({ type: "session.input_transcript.delta", event_id: "refusal", delta: "Please don't record me.", start_ms: 0, end_ms: 50 });
    await vi.advanceTimersByTimeAsync(850);
    expect(f.hangup).toHaveBeenCalledOnce(); expect(f.startRecording).not.toHaveBeenCalled();
    expect(f.store.fragment).not.toHaveBeenCalled(); expect(f.answer).not.toHaveBeenCalled();
    await f.finish();
    expect(f.store.finish).toHaveBeenCalledWith("recording_declined", "recording_declined", true);
  });
  it("tolerates an incidental audio click and an okay immediately after the completed notice", async () => {
    const f = setup(); await f.start();
    f.phone.event({ event: "media", stream_id: "stream", media: { track: "inbound", chunk: "1", payload: Buffer.alloc(new AudioQueue("pcm16").frameBytes, 23).toString("base64") } });
    const mark = await sayNotice(f, "pcm16", notice.replace("I’m", "I am").replace("AI", "A.I."));
    expect(mark).toBeTruthy(); expect(f.classifyDisclosureReply).not.toHaveBeenCalled();
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: mark } });
    await vi.advanceTimersByTimeAsync(1);
    f.live.event({ type: "session.input_transcript.delta", event_id: "okay", delta: "Okay.", start_ms: 500, end_ms: 600 });
    const handoff = (f.phone.sent.find((e) => e.event === "mark" && String((e.mark as { name?: string } | undefined)?.name).startsWith("handoff-"))?.mark as { name: string }).name;
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: handoff } });
    await vi.advanceTimersByTimeAsync(850);
    expect(f.classifyDisclosureReply).toHaveBeenCalledOnce();
    expect(f.store.handoffAcknowledged).toHaveBeenCalledOnce();
    expect(f.hangup).not.toHaveBeenCalled(); expect(f.store.fragment).not.toHaveBeenCalled();
    expect(f.live.sent.filter((e) => String(e.content).includes("Speak only this exact opening"))).toHaveLength(1);
    await f.finish();
  });
  it.each(["pcm16", "pcmu8"] as const)("ignores persistent low-level background noise during opening (%s)", async (profile) => {
    const f = setup(profile); await f.start();
    const quiet = Buffer.alloc(new AudioQueue(profile).frameBytes, profile === "pcm16" ? 0 : 240);
    if (profile === "pcm16") for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(120, i);
    // This is audible to the output-preservation helper, but it is not speech.
    expect(hasAudibleAudio(quiet, profile)).toBe(true);
    for (let i = 1; i <= 40; i++) {
      f.phone.event({ event: "media", stream_id: "stream", media: { track: "inbound", chunk: String(i), payload: quiet.toString("base64") } });
      await vi.advanceTimersByTimeAsync(20);
    }
    const mark = await sayNotice(f, profile); expect(mark).toBeTruthy();
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: mark } }); await vi.advanceTimersByTimeAsync(1);
    const handoff = (f.phone.sent.find((e) => e.event === "mark" && String((e.mark as { name?: string } | undefined)?.name).startsWith("handoff-"))?.mark as { name: string }).name;
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: handoff } }); await vi.advanceTimersByTimeAsync(30);
    expect(f.classifyDisclosureReply).not.toHaveBeenCalled(); expect(f.hangup).not.toHaveBeenCalled();
    expect(f.store.handoffAcknowledged).toHaveBeenCalledOnce(); await f.finish();
  });
  it("keeps a delayed healthy okay classification free and separate from the phone handoff timeout", async () => {
    const f = setup(); await f.start(); const mark = await sayNotice(f);
    f.classifyDisclosureReply.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve("repeat"), 2500)));
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: mark } }); await vi.advanceTimersByTimeAsync(1);
    f.live.event({ type: "session.input_transcript.delta", event_id: "slow-okay", delta: "Okay.", start_ms: 500, end_ms: 600 });
    const handoff = (f.phone.sent.find((e) => e.event === "mark" && String((e.mark as { name?: string } | undefined)?.name).startsWith("handoff-"))?.mark as { name: string }).name;
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: handoff } });
    const beforeReply = Date.now();
    await vi.advanceTimersByTimeAsync(3100);
    expect(f.hangup).not.toHaveBeenCalled(); expect(f.store.handoffStarted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.store.handoffStarted).toHaveBeenCalledOnce(); expect(f.store.handoffAcknowledged).toHaveBeenCalledOnce();
    expect(Date.parse(f.store.handoffStarted.mock.calls[0][1])).toBeGreaterThanOrEqual(beforeReply + 3300);
    expect(f.hangup).not.toHaveBeenCalled(); await f.finish();
  });
  it("rehearses the same opening on the approved pilot without the customer minute meter", async () => {
    const f = setup("pcm16", { session: { ...session, access_source: "pilot", disclosure_version: 1, public_notice_rehearsal: true } as VoiceSession });
    await f.start(); const mark = await sayNotice(f);
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: mark } }); await vi.advanceTimersByTimeAsync(1);
    const handoff = (f.phone.sent.find((e) => e.event === "mark" && String((e.mark as { name?: string } | undefined)?.name).startsWith("handoff-"))?.mark as { name: string }).name;
    f.phone.event({ event: "mark", stream_id: "stream", mark: { name: handoff } }); await vi.advanceTimersByTimeAsync(30);
    expect(f.store.beginDisclosure).toHaveBeenCalledOnce(); expect(f.store.handoffAcknowledged).toHaveBeenCalledOnce();
    expect(f.store.customerAudioStarted).not.toHaveBeenCalled(); expect(f.store.customerPlaybackAcknowledged).not.toHaveBeenCalled();
    await f.finish();
  });
  it("never activates on recording failure or missing handoff acknowledgment", async () => {
    const f = setup(); f.startRecording.mockRejectedValue(new Error("unavailable")); await f.start();
    const mark = await sayNotice(f); f.phone.event({ event: "mark", stream_id: "stream", mark: { name: mark } });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.handoffStarted).not.toHaveBeenCalled(); expect(f.hangup).toHaveBeenCalledOnce(); await f.finish();
    const g = setup(); await g.start(); const ready = await sayNotice(g);
    g.phone.event({ event: "mark", stream_id: "stream", mark: { name: ready } });
    await vi.advanceTimersByTimeAsync(3100);
    expect(g.store.handoffAcknowledged).not.toHaveBeenCalled(); expect(g.hangup).toHaveBeenCalledOnce(); await g.finish();
  });
});
