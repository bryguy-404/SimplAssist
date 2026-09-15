import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  AUDIO_PROFILES,
  AudioQueue,
  InboundReorderBuffer,
  decodeAudio,
  validateMediaFormat,
  type AudioProfileName,
} from "./audio";
import { CallTranscript } from "./transcript";
import { LIVE_INSTRUCTIONS } from "./knowledge";
import { VOICE_MODEL, type VoiceSession } from "./types";
import type { VoiceStore } from "./store";

export interface LiveSessionOptions {
  session: VoiceSession;
  phone: WebSocket;
  openaiKey: string;
  profile: AudioProfileName;
  store: VoiceStore;
  answer: (
    session: VoiceSession,
    delegationId: string,
    transcript: string,
    signal: AbortSignal,
  ) => Promise<string>;
  hangup: () => Promise<void>;
  onClosed: () => void;
  // Injected sockets/timing make the actual bridge testable without paid calls.
  connectOpenAI?: () => WebSocket;
}

/** Continuous audio bridge. There is no synthetic text-turn/commit loop. */
export class LiveCall {
  private readonly transcript = new CallTranscript();
  private readonly input: AudioQueue;
  private readonly output: AudioQueue;
  private readonly reorder = new InboundReorderBuffer();
  private openai: WebSocket | null = null;
  private streamId: string | null = null;
  private ready = false;
  private closing = false;
  private closed = false;
  private openedAt = Date.now();
  private lastCallerAt = Date.now();
  private warningSent = false;
  private idleWarningSent = false;
  private latestUsage = 0;
  private finalUsage = false;
  private audioSent = false;
  private outputFrames = 0;
  private playbackGeneration = 0;
  private pendingMarks = new Set<string>();
  private delegationGeneration = 0;
  private seenDelegations = new Set<string>();
  private delegationAbort: AbortController | null = null;
  private io: Promise<void> = Promise.resolve();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private heartbeatBusy = false;
  private finishReason = "completed";
  private finishError: string | null = null;
  private fallback = false;
  private resolveClosed!: () => void;
  readonly done = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(private readonly options: LiveSessionOptions) {
    // Retain early caller speech during the bounded startup handshake.
    // Flush it in order once the provider accepts audio; normal input is paced.
    this.input = new AudioQueue(options.profile, 12000);
    this.output = new AudioQueue(options.profile);
    options.phone.on("message", (data) => this.phoneEvent(data.toString()));
    options.phone.on(
      "error",
      () => void this.close("phone_connection_error", true),
    );
    options.phone.on(
      "close",
      () => void this.close("phone_disconnected", !this.ready),
    );
    this.later(() => {
      if (!this.ready) void this.close("startup_timeout", true);
    }, 12000);
    this.tick();
    this.heartbeat();
  }

  private later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }
  private persist(fn: () => Promise<void>) {
    this.io = this.io.then(fn).catch(() => {
      void this.close("persistence_failed", true);
    });
  }
  private sendLive(event: Record<string, unknown>) {
    if (this.openai?.readyState === WebSocket.OPEN) {
      if (this.openai.bufferedAmount > 128_000)
        throw new Error("openai_backpressure");
      this.openai.send(JSON.stringify({ event_id: randomUUID(), ...event }));
    }
  }
  private sendPhone(event: Record<string, unknown>) {
    if (this.options.phone.readyState === WebSocket.OPEN) {
      if (this.options.phone.bufferedAmount > 64_000)
        throw new Error("phone_backpressure");
      this.options.phone.send(JSON.stringify(event));
    }
  }

  private phoneEvent(raw: string) {
    if (this.closed) return;
    try {
      const event = JSON.parse(raw);
      if (event.event === "start") {
        if (this.streamId || this.closing)
          throw new Error("duplicate_stream_start");
        const start = event.start;
        if (
          !start ||
          start.call_control_id !== this.options.session.call_control_id ||
          start.call_session_id !== this.options.session.call_session_id ||
          start.from !== this.options.session.caller_phone ||
          start.to !== this.options.session.called_phone ||
          typeof event.stream_id !== "string"
        )
          throw new Error("stream_identity_mismatch");
        validateMediaFormat(this.options.profile, start.media_format);
        this.streamId = event.stream_id;
        this.startOpenAI();
      } else if (event.event === "media" && !this.closing) {
        if (!this.streamId || event.stream_id !== this.streamId)
          throw new Error("stream_identity_mismatch");
        if (event.media?.track !== "inbound") return;
        this.reorder.add(
          Number(event.media.chunk),
          decodeAudio(event.media.payload, this.options.profile),
          Date.now(),
        );
      } else if (event.event === "mark") {
        const name = event.mark?.name;
        if (
          typeof name === "string" &&
          this.pendingMarks.delete(name) &&
          name.startsWith(`played-${this.playbackGeneration}-`) &&
          !this.closing
        ) {
          this.persist(() => this.options.store.playbackAcknowledged());
        }
      } else if (event.event === "stop") {
        void this.close("caller_hangup", !this.ready);
      }
    } catch (error) {
      void this.close(
        error instanceof Error && /^[a-z_]+$/.test(error.message)
          ? error.message
          : "invalid_phone_event",
        true,
      );
    }
  }

  private startOpenAI() {
    const ws =
      this.options.connectOpenAI?.() ??
      new WebSocket("wss://api.openai.com/v1/live/sessions", {
        headers: { Authorization: `Bearer ${this.options.openaiKey}` },
        handshakeTimeout: 8000,
        maxPayload: 512_000,
      });
    this.openai = ws;
    ws.on("open", () => {
      if (this.closing) {
        ws.close();
        return;
      }
      this.openedAt = Date.now();
      this.sendLive({
        type: "session.start",
        session: {
          model: VOICE_MODEL,
          instructions: LIVE_INSTRUCTIONS,
          audio: {
            format: AUDIO_PROFILES[this.options.profile].format,
            output: { voice: "marin" },
          },
          delegation: { type: "client" },
          store: false,
        },
      });
    });
    ws.on("message", (data) => this.liveEvent(data.toString()));
    ws.on("error", () => void this.close("openai_connection_error", true));
    ws.on("close", () => {
      if (!this.closing) void this.close("openai_disconnected", true);
      else void this.finish();
    });
  }

  private liveEvent(raw: string) {
    if (this.closed) return;
    try {
      const event = JSON.parse(raw);
      switch (event.type) {
        case "session.started": {
          if (this.ready || typeof event.session?.id !== "string")
            throw new Error("invalid_session_start");
          const format = event.session.audio?.format;
          const expected = AUDIO_PROFILES[this.options.profile].format;
          if (
            !format ||
            format.type !== expected.type ||
            format.rate !== expected.rate
          )
            throw new Error("openai_audio_format_mismatch");
          const id = event.session.id as string;
          this.persist(async () => {
            await this.options.store.activate(id);
            if (this.closing) return;
            this.ready = true;
            const earlyAudio = this.input.takeBuffered();
            if (earlyAudio.length)
              this.sendLive({
                type: "session.input_audio.append",
                audio: earlyAudio.toString("base64"),
              });
            this.sendLive({
              type: "session.instructions.append",
              delegation_id: null,
              content:
                "Begin the conversation now: greet the caller briefly and ask how you can help with business questions, then listen.",
            });
          });
          break;
        }
        case "session.output_audio.delta":
          if (!this.closing)
            this.output.append(decodeAudio(event.delta, this.options.profile));
          break;
        case "session.input_transcript.delta":
        case "session.output_transcript.delta": {
          const fragment = {
            eventId: event.event_id,
            role:
              event.type === "session.input_transcript.delta"
                ? ("customer" as const)
                : ("assistant" as const),
            text: event.delta,
            startMs: event.start_ms,
            endMs: event.end_ms,
          };
          if (this.transcript.add(fragment)) {
            if (fragment.role === "customer") {
              this.lastCallerAt = Date.now();
              this.idleWarningSent = false;
            }
            this.persist(() => this.options.store.fragment(fragment));
          }
          break;
        }
        case "session.delegation.created":
          if (
            !this.closing &&
            event.delegation?.target === "client" &&
            typeof event.delegation.id === "string" &&
            Number.isFinite(event.offset_ms)
          )
            this.delegate(event.delegation.id, event.offset_ms);
          break;
        case "session.usage.updated":
          this.updateUsage(event.usage?.seconds, false);
          break;
        case "session.closed":
          this.updateUsage(event.usage?.seconds, true);
          if (!this.closing) {
            this.finishReason = "provider_closed";
            this.finishError = "unexpected_provider_close";
            this.fallback = true;
            this.closing = true;
          }
          void this.finish();
          break;
        case "error":
          void this.close("openai_protocol_error", true);
          break;
      }
    } catch (error) {
      void this.close(
        error instanceof Error && /^[a-z_]+$/.test(error.message)
          ? error.message
          : "invalid_openai_event",
        true,
      );
    }
  }

  private updateUsage(seconds: unknown, confirmed: boolean) {
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > 86400
    ) {
      if (confirmed) this.finalUsage = false;
      return;
    }
    this.latestUsage = Math.max(this.latestUsage, seconds);
    this.finalUsage ||= confirmed;
    const current = this.latestUsage;
    this.persist(() => this.options.store.usage(current, confirmed));
  }

  private delegate(id: string, offsetMs: number) {
    if (this.seenDelegations.has(id)) return;
    this.seenDelegations.add(id);
    const generation = ++this.delegationGeneration;
    this.delegationAbort?.abort();
    const abort = new AbortController();
    this.delegationAbort = abort;
    // Transcripts can trail the delegation event. This is a bounded coalescing
    // window, never a declaration that a fragment completes a customer turn.
    this.later(() => {
      if (this.closing || generation !== this.delegationGeneration) return;
      const callerEnd = Math.max(offsetMs, this.transcript.latestCallerEndMs);
      if (!this.transcript.hasCallerText) {
        this.sendLive({
          type: "session.commentary.append",
          delegation_id: id,
          content:
            "The caller's question transcript is not available yet. Ask them briefly to repeat the question; do not guess.",
        });
        return;
      }
      let settled = false;
      this.later(() => {
        if (
          !settled &&
          !abort.signal.aborted &&
          generation === this.delegationGeneration
        ) {
          abort.abort();
          void this.close("backend_timeout", true);
        }
      }, 9000);
      void this.options
        .answer(
          this.options.session,
          id,
          this.transcript.snapshot(),
          abort.signal,
        )
        .then((answer) => {
          settled = true;
          if (
            this.closing ||
            abort.signal.aborted ||
            generation !== this.delegationGeneration
          )
            return;
          if (this.transcript.latestCallerEndMs > callerEnd) {
            this.sendLive({
              type: "session.commentary.append",
              delegation_id: id,
              content:
                "Discard the obsolete backend answer. The caller spoke again or corrected the question. Delegate their current question before answering.",
            });
            return;
          }
          this.sendLive({
            type: "session.commentary.append",
            delegation_id: id,
            content: answer,
          });
        })
        .catch(() => {
          settled = true;
          if (!abort.signal.aborted && generation === this.delegationGeneration)
            void this.close("backend_failed", true);
        });
    }, 250);
  }

  private tick() {
    if (this.closed) return;
    try {
      if (!this.closing) {
        for (const bytes of this.reorder.drain(Date.now()))
          this.input.append(bytes);
      }
      if (this.ready && !this.closing) {
        this.sendLive({
          type: "session.input_audio.append",
          audio: this.input.take(true)!.toString("base64"),
        });
        const frame = this.output.take();
        if (frame) {
          this.sendPhone({
            event: "media",
            media: { payload: frame.toString("base64") },
          });
          if (!this.audioSent) {
            this.audioSent = true;
            this.persist(() => this.options.store.audioSent());
          }
          if (++this.outputFrames % 25 === 0) {
            const name = `played-${this.playbackGeneration}-${this.outputFrames}`;
            this.pendingMarks.add(name);
            if (this.pendingMarks.size > 20)
              throw new Error("playback_stalled");
            this.sendPhone({ event: "mark", mark: { name } });
          }
        }
        const elapsed = (Date.now() - this.openedAt) / 1000;
        const limit = this.options.session.reserved_seconds;
        if (!this.warningSent && elapsed >= limit - 60) {
          this.warningSent = true;
          this.sendLive({
            type: "session.instructions.append",
            delegation_id: null,
            content:
              "Tell the caller this test call has less than one minute remaining, then continue briefly.",
          });
        }
        // Reserve 15 seconds for the provider's final-usage close handshake.
        if (elapsed >= limit - 15) void this.close("time_limit", false);
        if (!this.idleWarningSent && Date.now() - this.lastCallerAt > 45000) {
          this.idleWarningSent = true;
          this.sendLive({
            type: "session.instructions.append",
            delegation_id: null,
            content:
              "Ask the caller if they are still there. Explain that the test call will end soon if they have no more questions.",
          });
        }
        if (Date.now() - this.lastCallerAt > 65000)
          void this.close("idle_timeout", false);
      }
    } catch {
      void this.close("audio_transport_failed", true);
    }
    this.later(() => this.tick(), 20);
  }

  private heartbeat() {
    if (this.closed) return;
    if (!this.heartbeatBusy && !this.closing) {
      this.heartbeatBusy = true;
      void this.options.store
        .heartbeat()
        .then((allowed) => {
          if (!allowed) void this.close("operational_stop", false);
        })
        .catch(() => void this.close("operational_check_failed", true))
        .finally(() => {
          this.heartbeatBusy = false;
        });
    }
    this.later(() => this.heartbeat(), 3000);
  }

  async close(reason: string, fallback: boolean): Promise<void> {
    if (this.closing || this.closed) return this.done;
    this.closing = true;
    this.finishReason = reason;
    this.fallback = fallback;
    this.finishError = fallback ? reason : null;
    this.delegationAbort?.abort();
    this.output.clear();
    this.input.clear();
    this.playbackGeneration++;
    this.pendingMarks.clear();
    try {
      this.sendPhone({ event: "clear" });
    } catch {
      /* Connection may already be closed. */
    }
    if (this.openai?.readyState === WebSocket.OPEN) {
      // The event listener is installed before the close request. Keep listening
      // for session.closed, which contains the final cumulative usage.
      try {
        this.sendLive({ type: "session.close" });
      } catch {
        /* bounded finish below */
      }
      this.later(() => void this.finish(), 15000);
    } else {
      await this.finish();
    }
    return this.done;
  }

  private async finish() {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.delegationAbort?.abort();
    for (const timer of Array.from(this.timers)) clearTimeout(timer);
    this.timers.clear();
    this.openai?.terminate();
    this.options.phone.close(1000);
    try {
      await this.io;
      await this.options.store.usage(this.latestUsage, this.finalUsage);
      await this.options.store.finish(
        this.finishReason,
        this.finishError,
        this.fallback,
      );
    } catch {
      // An expired heartbeat remains a durable recovery signal. Do not log
      // provider payloads, stream credentials, audio or transcript content.
      console.error("[voice] finalization requires recovery", {
        sessionId: this.options.session.id,
      });
    }
    try {
      await this.options.hangup();
    } catch {
      /* Webhook/maintenance retries close failed provider calls. */
    }
    this.options.onClosed();
    this.resolveClosed();
  }
}
