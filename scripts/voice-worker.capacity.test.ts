import { EventEmitter } from "node:events";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterAll, expect, it, vi } from "vitest";
import type { LiveSessionOptions } from "../src/lib/voice/liveSession";
import type { VoiceSession } from "../src/lib/voice/types";

// Exercise the actual HTTP/WebSocket worker and paced LiveCall bridge. Only
// external providers/storage are mocked; these are not paid or real phone calls.
const state = vi.hoisted(() => ({
  servers: [] as Server[], providers: new Map<string, Provider>(),
  stores: new Map<string, Record<string, ReturnType<typeof vi.fn>>>(),
  shutdown: undefined as (() => void) | undefined,
  sessions: new Map<string, VoiceSession>(),
  answer: vi.fn(), hangup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return { ...actual, createServer: (...args: Parameters<typeof actual.createServer>) => {
    const server = actual.createServer(...args); state.servers.push(server); return server;
  } };
});
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => ({ select: () => ({
  limit: async () => ({ error: null }), eq: (_key: string, id: string) => ({ single: async () => ({ data: { name: id }, error: null }) }),
}) }) }) }));
vi.mock("telnyx", () => ({ default: class { calls = { actions: {
  hangup: state.hangup, startRecording: vi.fn().mockResolvedValue(undefined),
  stopRecording: vi.fn().mockResolvedValue(undefined), stopPlayback: vi.fn().mockResolvedValue(undefined),
} }; } }));
vi.mock("../src/lib/voice/preparation", () => ({ VoicePreparations: class {
  size = 0; has() { return false; } take() { return null; } closeAll() {} async prepare() {}
} }));
vi.mock("../src/lib/voice/answer", () => ({ createVoiceAnswerer: () => state.answer }));
vi.mock("../src/lib/voice/disclosure", () => ({ createDisclosureReplyClassifier: () => vi.fn().mockResolvedValue("refuse") }));
vi.mock("../src/lib/voice/store", () => ({
  consumeStreamToken: async (_db: unknown, token: string) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    const session = state.sessions.get(token); state.sessions.delete(token); return session ?? null;
  },
  createVoiceStore: (_db: unknown, session: VoiceSession) => {
    const store = Object.fromEntries([
      "activate", "beginDisclosure", "completeDisclosure", "recordingStarted", "handoffStarted", "handoffAcknowledged",
      "fragment", "usage", "audioSent", "playbackAcknowledged", "customerAudioStarted", "customerPlaybackAcknowledged", "customerTermination", "finish",
    ].map((name) => [name, vi.fn().mockResolvedValue(undefined)]));
    store.heartbeat = vi.fn().mockResolvedValue(true); state.stores.set(session.id, store); return store;
  },
}));
vi.mock("../src/lib/voice/liveSession", async (original) => {
  const actual = await original<typeof import("../src/lib/voice/liveSession")>();
  return { ...actual, LiveCall: class extends actual.LiveCall {
    constructor(options: LiveSessionOptions) {
      super({ ...options, connectOpenAI: () => {
        const provider = new Provider(options); state.providers.set(options.session.id, provider);
        setImmediate(() => provider.emit("open")); return provider as unknown as WebSocket;
      } });
    }
  } };
});

class Provider extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  received: Record<string, unknown>[] = [];
  constructor(readonly options: LiveSessionOptions) { super(); }
  event(event: unknown) { this.emit("message", Buffer.from(JSON.stringify(event))); }
  send(raw: string) {
    const event = JSON.parse(raw); this.received.push(event);
    if (event.type === "session.start") setImmediate(() => this.event({ type: "session.started", session: {
      id: `openai-${this.options.session.id}`, audio: { format: event.session.audio.format },
    } }));
    if (event.type === "session.instructions.append") setImmediate(() => {
      this.event({ type: "session.instructions.appended", client_event_id: event.event_id });
      if (state.stores.get(this.options.session.id)?.handoffAcknowledged.mock.calls.length) return;
      this.event({ type: "session.output_transcript.delta", event_id: "notice", start_ms: 0, end_ms: 300,
        delta: `Hi, thanks for calling ${this.options.businessName}. I’m the AI assistant, and this call will be recorded.` });
      this.event({ type: "session.output_audio.delta", delta: Buffer.alloc(640 * 10, 17).toString("base64") });
    });
    if (event.type === "session.close") setImmediate(() => this.event({ type: "session.closed", usage: { seconds: 4 } }));
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
}

const phones: WebSocket[] = [];
const intervals: ReturnType<typeof setInterval>[] = [];
let exitSpy: ReturnType<typeof vi.spyOn>;
let origin = "";
async function eventually(check: () => void, timeout = 5000) {
  const started = Date.now(); let last: unknown;
  while (Date.now() - started < timeout) {
    try { check(); return; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw last;
}
async function ready() {
  return new Promise<{ activeCalls: number; ready: boolean }>((resolve, reject) => {
    get(`${origin}/ready`, { headers: { Authorization: `Bearer ${"x".repeat(40)}` } }, (response) => {
      let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve(JSON.parse(body)));
    }).on("error", reject);
  });
}
function addSession(id: string) {
  state.sessions.set(id, { id, business_id: Number(id) < 3 ? "business-a" : "business-b", call_control_id: `control-${id}`,
    call_session_id: `telnyx-${id}`, caller_phone: `+1317555010${id}`, called_phone: "+15742638634", reserved_seconds: 600,
    access_source: "commercial", disclosure_version: 1,
  } as VoiceSession);
}
async function connect(id: string) {
  return new Promise<{ phone: WebSocket; received: Record<string, unknown>[] }>((resolve, reject) => {
    const received: Record<string, unknown>[] = [];
    const phone = new WebSocket(`${origin.replace("http", "ws")}/media?token=${id}`); phones.push(phone);
    phone.on("error", reject);
    phone.on("unexpected-response", (_request, response) => { response.resume(); phone.terminate(); reject(new Error(`HTTP ${response.statusCode}`)); });
    phone.on("message", (raw) => {
      const event = JSON.parse(raw.toString()); received.push(event);
      if (event.event === "mark") phone.send(JSON.stringify({ event: "mark", stream_id: `stream-${id}`, mark: event.mark }));
    });
    phone.on("open", () => {
      phone.send(JSON.stringify({ event: "start", stream_id: `stream-${id}`, start: {
        call_control_id: `control-${id}`, call_session_id: `telnyx-${id}`, from: `+1317555010${id}`, to: "+15742638634",
        media_format: { encoding: "L16", sample_rate: 16000, channels: 1 },
      } }));
      resolve({ phone, received });
    });
  });
}

afterAll(async () => {
  for (const interval of intervals) clearInterval(interval);
  state.shutdown?.();
  for (const phone of phones) if (phone.readyState !== WebSocket.CLOSED) phone.terminate();
  if (exitSpy) await eventually(() => expect(exitSpy).toHaveBeenCalled(), 6000);
  for (const server of state.servers) server.close();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

it("serves four simultaneous real WebSocket audio bridges, rejects overflow, isolates answers and releases capacity", async () => {
  for (const [key, value] of Object.entries({ OPENAI_API_KEY: "fake", VOICE_INTERNAL_TOKEN: "x".repeat(40), NEXT_PUBLIC_APP_URL: "https://app.example.test",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "fake", ANTHROPIC_API_KEY: "fake", TELNYX_API_KEY: "fake",
    VOICE_AUDIO_PROFILE: "pcm16", VOICE_ACTIONS_ROLLOUT: "false", PORT: "0" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  const setIntervalOriginal = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
    const timer = setIntervalOriginal(...args); intervals.push(timer); return timer;
  }) as typeof setInterval);
  const processOnOriginal = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
    if (event === "SIGTERM") { state.shutdown = listener; return process; }
    if (event === "SIGINT") return process;
    return processOnOriginal(event, listener);
  }) as typeof process.on);
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  state.answer.mockImplementation(async (session: VoiceSession) => `Verified answer for ${session.business_id}.`);
  await import("./voice-worker");
  await eventually(() => expect(state.servers[0]?.listening).toBe(true));
  origin = `http://127.0.0.1:${(state.servers[0].address() as AddressInfo).port}`;
  expect(await ready()).toMatchObject({ ready: true, activeCalls: 0 });
  for (const id of ["1", "2", "3", "4", "5"]) addSession(id);
  const calls = await Promise.all(["1", "2", "3", "4"].map(connect));
  await expect(connect("5")).rejects.toThrow("HTTP 503");
  expect(state.sessions.has("5")).toBe(true); // Overflow does not consume its stream credential.
  await eventually(() => {
    expect(state.stores.size).toBe(4);
    for (const store of Array.from(state.stores.values())) expect(store.handoffAcknowledged).toHaveBeenCalledOnce();
  });
  expect(await ready()).toMatchObject({ ready: true, activeCalls: 4 });
  // One hundred paced 20ms frames in each direction, concurrently in all calls.
  for (let frame = 1; frame <= 100; frame++) {
    for (const [index, call] of Array.from(calls.entries())) {
      const id = String(index + 1); const audio = Buffer.alloc(640, 30 + index).toString("base64");
      call.phone.send(JSON.stringify({ event: "media", stream_id: `stream-${id}`, media: { track: "inbound", chunk: String(frame), payload: audio } }));
      state.providers.get(id)!.event({ type: "session.output_audio.delta", delta: audio });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await eventually(() => {
    for (const [index, call] of Array.from(calls.entries())) {
      const payload = Buffer.alloc(640, 30 + index).toString("base64");
      expect(call.received.filter((event) => event.event === "media" && (event.media as { payload: string }).payload === payload)).toHaveLength(100);
      expect(state.providers.get(String(index + 1))!.received.filter((event) => event.type === "session.input_audio.append" && event.audio === payload)).toHaveLength(100);
    }
  });
  for (const [id, provider] of Array.from(state.providers)) {
    provider.event({ type: "session.input_transcript.delta", event_id: `question-${id}`, delta: `Question from caller ${id}`, start_ms: 5000, end_ms: 5500 });
    provider.event({ type: "session.delegation.created", offset_ms: 5500, delegation: { id: `delegation-${id}`, target: "client" } });
  }
  await eventually(() => expect(state.answer).toHaveBeenCalledTimes(4));
  for (const [id, provider] of Array.from(state.providers)) {
    await eventually(() => expect(provider.received).toContainEqual(expect.objectContaining({ type: "session.commentary.append", delegation_id: `delegation-${id}`, content: `Verified answer for ${Number(id) < 3 ? "business-a" : "business-b"}.` })));
    expect(state.stores.get(id)!.finish).not.toHaveBeenCalled();
  }
  calls[0].phone.send(JSON.stringify({ event: "stop", stream_id: "stream-1" }));
  await eventually(() => expect(state.stores.get("1")!.finish).toHaveBeenCalledOnce());
  expect(await ready()).toMatchObject({ activeCalls: 3 });
  await connect("5");
  await eventually(() => expect(state.stores.get("5")?.handoffAcknowledged).toHaveBeenCalledOnce());
  expect(await ready()).toMatchObject({ activeCalls: 4 });
}, 15000);
