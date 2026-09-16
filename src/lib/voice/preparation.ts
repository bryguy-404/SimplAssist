import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUDIO_PROFILES, type AudioProfileName } from "./audio";
import { buildLiveInstructions } from "./conversationStyle";
import { VOICE_MODEL, type VoiceSession } from "./types";

export interface PreparedLiveConnection {
  socket: WebSocket;
  startedEvent: string;
  startedAt: number;
  seconds: number;
}
/** Owns the provider until the authenticated phone stream takes ownership. */
export class VoicePreparations {
  private entries = new Map<
    string,
    {
      session: VoiceSession;
      socket: WebSocket;
      startedEvent: string | null;
      startedAt: number;
      seconds: number;
      closing: boolean;
      timer: ReturnType<typeof setInterval>;
      detach: () => void;
    }
  >();
  constructor(
    private db: SupabaseClient,
    private key: string,
    private profile: AudioProfileName,
    private actionsEnabled: boolean,
  ) {}
  get size() {
    return this.entries.size;
  }
  has(id: string) {
    return this.entries.has(id);
  }
  async prepare(sessionId: string) {
    if (this.entries.has(sessionId)) return;
    const { data: s, error } = await this.db.rpc("claim_voice_preparation", {
      p_session_id: sessionId,
    });
    if (error || !s?.id) return;
    const session = s as VoiceSession;
    const { data: business, error: be } = await this.db
      .from("businesses")
      .select("name")
      .eq("id", session.action_business_id || session.business_id)
      .single();
    if (be || !business?.name)
      throw new Error("preparation_business_unavailable");
    const socket = new WebSocket("wss://api.openai.com/v1/live/sessions", {
      headers: { Authorization: `Bearer ${this.key}` },
      handshakeTimeout: 8000,
      maxPayload: 512000,
    });
    const entry = {
      session,
      socket,
      startedEvent: null as string | null,
      startedAt: Date.now(),
      seconds: 0,
      closing: false,
      timer: null as unknown as ReturnType<typeof setInterval>,
      detach: () => {},
    };
    this.entries.set(sessionId, entry);
    let io: Promise<unknown> = Promise.resolve();
    const usage = (seconds: number, confirmed: boolean) => {
      if (!Number.isFinite(seconds) || seconds < 0) return;
      entry.seconds = Math.max(entry.seconds, seconds);
      io = io
        .then(async () => {
          const r = await this.db.rpc("update_voice_usage", {
            p_session_id: sessionId,
            p_seconds: entry.seconds,
            p_confirmed: confirmed,
          });
          if (r.error) throw new Error("preparation_usage_failed");
        })
        .catch(() => this.close(sessionId));
    };
    const message = (raw: WebSocket.RawData) => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === "session.started") {
          if (
            entry.startedEvent ||
            event.session?.audio?.format?.type !==
              AUDIO_PROFILES[this.profile].format.type ||
            event.session?.audio?.format?.rate !==
              AUDIO_PROFILES[this.profile].format.rate
          )
            throw new Error("preparation_format_mismatch");
          entry.startedEvent = raw.toString();
          io = io
            .then(async () => {
              const r = await this.db
                .from("voice_sessions")
                .update({ prepared_openai_id: event.session.id })
                .eq("id", sessionId)
                .is("prepared_openai_id", null);
              if (r.error) throw new Error("preparation_identity_failed");
            })
            .catch(() => this.close(sessionId));
        } else if (event.type === "session.usage.updated")
          usage(event.usage?.seconds, false);
        else if (event.type === "session.closed") {
          usage(event.usage?.seconds, true);
          socket.close();
        } else if (event.type === "error") this.close(sessionId);
        // No prepared speech or transcript is delivered, persisted as heard, or
        // used for actions. The live greeting starts only after media attachment.
      } catch {
        this.close(sessionId);
      }
    };
    const cleanup = () => {
      clearInterval(entry.timer);
      this.entries.delete(sessionId);
    };
    const errorHandler = () => this.close(sessionId);
    socket.on("message", message);
    socket.on("close", cleanup);
    socket.on("error", errorHandler);
    socket.on("open", () => {
      if (entry.closing) {
        socket.close();
        return;
      }
      socket.send(
        JSON.stringify({
          type: "session.start",
          event_id: randomUUID(),
          session: {
            model: VOICE_MODEL,
            instructions:
              buildLiveInstructions(business.name, true, this.actionsEnabled) +
              "\nWait silently for the application's fresh opening instruction before greeting. No caller has joined yet.",
            audio: {
              format: AUDIO_PROFILES[this.profile].format,
              output: { voice: "marin" },
            },
            delegation: { type: "client" },
            store: false,
          },
        }),
      );
    });
    let checking = false;
    let lastCheck = 0;
    entry.timer = setInterval(() => {
      if (entry.closing) return;
      if (Date.now() - entry.startedAt > 25000) {
        this.close(sessionId);
        return;
      }
      if (
        entry.startedEvent &&
        socket.readyState === WebSocket.OPEN &&
        socket.bufferedAmount < 64000
      ) {
        const f = AUDIO_PROFILES[this.profile];
        socket.send(
          JSON.stringify({
            type: "session.input_audio.append",
            audio: Buffer.alloc(
              (f.rate * f.bytesPerSample) / 50,
              f.silence,
            ).toString("base64"),
          }),
        );
      }
      if (!checking && Date.now() - lastCheck >= 1000) {
        checking = true;
        lastCheck = Date.now();
        void Promise.resolve(
          this.db
            .from("voice_sessions")
            .select("status,phone_ended_at")
            .eq("id", sessionId)
            .single(),
        )
          .then(async (r) => {
            const cfg = await this.db
              .from("voice_pilot_settings")
              .select("enabled,preparation_enabled")
              .eq("business_id", session.business_id)
              .single();
            if (
              r.error ||
              !r.data ||
              r.data.phone_ended_at ||
              ["closing", "closed"].includes(r.data.status) ||
              cfg.error ||
              !cfg.data?.enabled ||
              !cfg.data.preparation_enabled
            )
              this.close(sessionId);
          })
          .catch(() => this.close(sessionId))
          .finally(() => {
            checking = false;
          });
      }
    }, 20);
    entry.detach = () => {
      clearInterval(entry.timer);
      socket.off("message", message);
      socket.off("close", cleanup);
      socket.off("error", errorHandler);
      this.entries.delete(sessionId);
    };
  }
  take(sessionId: string): PreparedLiveConnection | null {
    const e = this.entries.get(sessionId);
    if (
      !e ||
      e.closing ||
      !e.startedEvent ||
      e.socket.readyState !== WebSocket.OPEN
    )
      return null;
    e.detach();
    return {
      socket: e.socket,
      startedEvent: e.startedEvent,
      startedAt: e.startedAt,
      seconds: e.seconds,
    };
  }
  close(id: string) {
    const e = this.entries.get(id);
    if (!e || e.closing) return;
    e.closing = true;
    clearInterval(e.timer);
    if (e.socket.readyState === WebSocket.OPEN)
      e.socket.send(
        JSON.stringify({ type: "session.close", event_id: randomUUID() }),
      );
    else e.socket.close();
    setTimeout(() => {
      e.socket.terminate();
      this.entries.delete(id);
    }, 15000).unref();
  }
  closeAll() {
    for (const id of Array.from(this.entries.keys())) this.close(id);
  }
}
