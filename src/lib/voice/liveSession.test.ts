import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { LiveCall } from "./liveSession";
import {
  AUDIO_PROFILES,
  AudioQueue,
  InboundReorderBuffer,
  validateMediaFormat,
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

function harness(profile: "pcm16" | "pcmu8" = "pcm16") {
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
  const call = new LiveCall({
    session,
    phone: phone.asWebSocket(),
    openaiKey: "test-key",
    profile,
    store,
    answer,
    hangup,
    onClosed: vi.fn(),
    connectOpenAI: () => live.asWebSocket(),
  });
  async function start(delayAudio = false) {
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
  }
  async function finish(reason = "caller_hangup") {
    const pending = call.close(reason, false);
    live.event({ type: "session.closed", usage: { seconds: 3 } });
    await pending;
  }
  return { phone, live, store, answer, hangup, call, start, finish };
}

describe("continuous phone bridge", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
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
    expect(h.answer.mock.calls[0][2]).toContain(
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
  it("closes on bounded backend waits and does not replay a failed question", async () => {
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
    expect(h.live.sent.some((e) => e.type === "session.close")).toBe(true);
    h.live.event({ type: "session.closed", usage: { seconds: 10 } });
    await h.call.done;
    expect(h.store.finish).toHaveBeenCalledWith(
      "backend_timeout",
      "backend_timeout",
      true,
    );
    expect(h.answer).toHaveBeenCalledOnce();
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
