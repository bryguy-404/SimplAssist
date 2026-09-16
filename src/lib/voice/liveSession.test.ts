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

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
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
    fragment: vi.fn().mockResolvedValue(undefined),
    usage: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(true),
    audioSent: vi.fn().mockResolvedValue(undefined),
    playbackAcknowledged: vi.fn().mockResolvedValue(undefined),
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
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
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
