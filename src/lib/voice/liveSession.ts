import type { PreparedLiveConnection } from "./preparation";
import type { VoiceAnswer } from "./actions";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  AUDIO_PROFILES,
  AudioQueue,
  InboundReorderBuffer,
  decodeAudio,
  hasAudibleAudio,
  validateMediaFormat,
  type AudioProfileName,
} from "./audio";
import { CallTranscript } from "./transcript";
import { buildLiveGreeting, buildLiveInstructions } from "./conversationStyle";
import { VOICE_MODEL, type VoiceSession } from "./types";
import type { VoiceStore } from "./store";

export interface LiveSessionOptions {
  session: VoiceSession;
  businessName: string;
  phone: WebSocket;
  openaiKey: string;
  profile: AudioProfileName;
  store: VoiceStore;
  answer: (
    session: VoiceSession,
    delegationId: string,
    transcript: string,
    signal: AbortSignal,
  ) => Promise<string | VoiceAnswer>;
  prepared?: PreparedLiveConnection;
  actionsEnabled?: boolean;
  acknowledgeActionPlayback?: (
    actionId: string,
    eventId: string,
    callerEndMs: number,
  ) => Promise<void>;
  hangup: () => Promise<void>;
  onClosed: () => void;
  stopConnectingRingback?: () => Promise<void>;
  onStartupTiming?: (phase: string, elapsedMs: number) => void;
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
  private readonly connectedAt = Date.now();
  private openingReleased: boolean;
  private openingSwitching = false;
  private openingPreroll: Buffer[] = [];
  private greetingEventId: string | null = null;
  private greetingAcknowledged = false;
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
  private pendingAction: {
    id: string;
    after: number;
    lastAssistantEvent: string | null;
    callerEnd: number;
    marked: boolean;
  } | null = null;
  private actionMarks = new Map<
    string,
    { id: string; eventId: string; callerEnd: number }
  >();
  private lastAudibleOutputAt = 0;
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
    this.openingReleased = !options.stopConnectingRingback;
    // At most two seconds of speech can wait for the bounded ring-stop command.
    // Return to the normal shallow queue as soon as that startup buffer drains.
    this.output = new AudioQueue(
      options.profile,
      this.openingReleased ? 1500 : 3000,
    );
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

  private startupTiming(phase: string) {
    this.options.onStartupTiming?.(phase, Date.now() - this.connectedAt);
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
        this.startupTiming("phone_stream_started");
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
        const actionMark = this.actionMarks.get(name);
        if (actionMark) {
          this.actionMarks.delete(name);
          if (
            !this.closing &&
            this.pendingAction?.id === actionMark.id &&
            this.transcript.latestCallerEndMs <= actionMark.callerEnd
          ) {
            this.persist(async () => {
              await this.options.acknowledgeActionPlayback?.(
                actionMark.id,
                actionMark.eventId,
                actionMark.callerEnd,
              );
            });
          }
        }
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
    const prepared = this.options.prepared;
    const ws =
      prepared?.socket ??
      this.options.connectOpenAI?.() ??
      new WebSocket("wss://api.openai.com/v1/live/sessions", {
        headers: { Authorization: `Bearer ${this.options.openaiKey}` },
        handshakeTimeout: 8000,
        maxPayload: 512_000,
      });
    this.openai = ws;
    if (prepared) {
      this.openedAt = prepared.startedAt;
      this.latestUsage = prepared.seconds;
    }
    ws.on("open", () => {
      if (this.closing) {
        ws.close();
        return;
      }
      this.openedAt = Date.now();
      this.startupTiming("openai_socket_open");
      this.sendLive({
        type: "session.start",
        session: {
          model: VOICE_MODEL,
          instructions: buildLiveInstructions(
            this.options.businessName,
            Boolean(this.options.session.prior_disclosure_acknowledged_at),
            Boolean(this.options.actionsEnabled),
          ),
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
    if (prepared) this.liveEvent(prepared.startedEvent);
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
          this.startupTiming("openai_session_started");
          this.persist(async () => {
            await this.options.store.activate(id);
            if (this.closing) return;
            this.ready = true;
            this.startupTiming("session_activated");
            const earlyAudio = this.input.takeBuffered();
            if (earlyAudio.length)
              this.sendLive({
                type: "session.input_audio.append",
                audio: earlyAudio.toString("base64"),
              });
            this.greetingEventId = randomUUID();
            this.sendLive({
              type: "session.instructions.append",
              event_id: this.greetingEventId,
              delegation_id: null,
              content: buildLiveGreeting(this.options.businessName),
            });
            this.later(() => {
              if (!this.greetingAcknowledged && !this.closing)
                void this.close("greeting_instruction_timeout", true);
            }, 8000);
            this.later(() => {
              if (!this.openingReleased && !this.closing)
                void this.close("greeting_audio_timeout", true);
            }, 12000);
          });
          break;
        }
        case "session.instructions.appended":
          if (
            event.client_event_id === this.greetingEventId &&
            !this.greetingAcknowledged &&
            !this.closing
          ) {
            this.greetingAcknowledged = true;
            // Explicitly prompt the already configured greeting to begin; an
            // instruction acknowledgment alone is not evidence of speech.
            this.sendLive({
              type: "session.commentary.append",
              delegation_id: null,
              content:
                "Begin the conversation now, following the opening instructions provided.",
            });
          }
          break;
        case "session.output_audio.delta":
          if (!this.closing) {
            const bytes = decodeAudio(event.delta, this.options.profile);
            if (hasAudibleAudio(bytes, this.options.profile))
              this.lastAudibleOutputAt = Date.now();
            this.output.append(bytes);
          }
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
            if (
              fragment.role === "assistant" &&
              this.pendingAction &&
              Date.now() >= this.pendingAction.after
            ) {
              this.pendingAction.lastAssistantEvent = fragment.eventId;
              this.pendingAction.marked = false;
            }
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
      if (this.options.actionsEnabled)
        this.later(() => {
          if (
            !settled &&
            !abort.signal.aborted &&
            generation === this.delegationGeneration
          )
            this.sendLive({
              type: "session.commentary.append",
              delegation_id: id,
              content:
                "The backend is still checking. Briefly tell the caller you are checking; do not claim success or repeat the operation.",
            });
        }, 3000);
      this.later(
        () => {
          if (
            !settled &&
            !abort.signal.aborted &&
            generation === this.delegationGeneration
          ) {
            abort.abort();
            void this.close("backend_timeout", true);
          }
        },
        this.options.actionsEnabled ? 35000 : 9000,
      );
      void this.io
        .then(() =>
          this.options.answer(
            this.options.session,
            id,
            this.transcript.snapshot(),
            abort.signal,
          ),
        )
        .then((result) => {
          settled = true;
          const answer = typeof result === "string" ? result : result.text;
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
          if (typeof result !== "string" && result.confirmationActionId)
            this.pendingAction = {
              id: result.confirmationActionId,
              after: Date.now(),
              lastAssistantEvent: null,
              callerEnd: this.transcript.latestCallerEndMs,
              marked: false,
            };
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
        if (!this.openingReleased) this.prepareOpeningPlayback();
        const frame = this.openingReleased ? this.output.take() : null;
        if (frame) {
          this.sendPhone({
            event: "media",
            media: { payload: frame.toString("base64") },
          });
          if (!this.audioSent) {
            this.audioSent = true;
            this.startupTiming("first_audio_sent");
            this.persist(() => this.options.store.audioSent());
          }
          this.output.restrictToNormalBuffer();
          if (++this.outputFrames % 25 === 0) {
            const name = `played-${this.playbackGeneration}-${this.outputFrames}`;
            this.pendingMarks.add(name);
            if (this.pendingMarks.size > 20)
              throw new Error("playback_stalled");
            this.sendPhone({ event: "mark", mark: { name } });
          }
        }
        if (
          this.pendingAction &&
          !this.pendingAction.marked &&
          this.pendingAction.lastAssistantEvent &&
          this.transcript.latestCallerEndMs <= this.pendingAction.callerEnd &&
          this.output.pendingMs === 0 &&
          Date.now() - this.lastAudibleOutputAt > 200
        ) {
          const name = `action-${randomUUID()}`;
          this.pendingAction.marked = true;
          this.actionMarks.set(name, {
            id: this.pendingAction.id,
            eventId: this.pendingAction.lastAssistantEvent,
            callerEnd: this.pendingAction.callerEnd,
          });
          if (this.actionMarks.size > 20)
            throw new Error("action_playback_stalled");
          this.sendPhone({ event: "mark", mark: { name } });
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

  private prepareOpeningPlayback() {
    if (this.openingSwitching) return;
    let frame: Buffer | null;
    while ((frame = this.output.take())) {
      if (!hasAudibleAudio(frame, this.options.profile)) {
        this.openingPreroll.push(frame);
        if (this.openingPreroll.length > 5) this.openingPreroll.shift();
        continue;
      }
      // Retain 100 ms before detected speech so the beginning is not clipped.
      const remaining = this.output.takeBuffered();
      this.output.append(
        Buffer.concat([...this.openingPreroll, frame, remaining]),
      );
      this.openingPreroll = [];
      this.openingSwitching = true;
      this.startupTiming("audible_opening_buffered");
      this.later(() => {
        if (!this.openingReleased && !this.closing)
          void this.close("ringback_stop_timeout", true);
      }, 2000);
      void this.options.stopConnectingRingback!()
        .then(() => {
          if (this.closing) return;
          this.startupTiming("ringback_stop_acknowledged");
          this.openingReleased = true;
        })
        .catch(() => void this.close("ringback_stop_failed", true));
      break;
    }
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
    this.openingPreroll = [];
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
