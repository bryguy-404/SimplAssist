import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({
  sockets: [] as unknown[],
  rpc: vi.fn(),
  from: vi.fn(),
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      readyState = 1;
      bufferedAmount = 0;
      sent: Record<string, unknown>[] = [];
      constructor() {
        super();
        mocks.sockets.push(this);
      }
      send(value: string) {
        this.sent.push(JSON.parse(value));
      }
      close() {
        if (this.readyState !== 3) {
          this.readyState = 3;
          this.emit("close");
        }
      }
      terminate() {
        this.close();
      }
    },
  };
});
import { VoicePreparations } from "./preparation";
interface TestSocket extends EventEmitter {
  sent: Record<string, unknown>[];
  close: () => void;
}
function event(socket: TestSocket, data: unknown) {
  socket.emit("message", Buffer.from(JSON.stringify(data)));
}
function start(socket: TestSocket) {
  socket.emit("open");
  event(socket, {
    type: "session.started",
    session: {
      id: "live-id",
      audio: { format: { type: "audio/pcm", rate: 16000 } },
    },
  });
}
function manager() {
  return new VoicePreparations(
    { rpc: mocks.rpc, from: mocks.from } as unknown as SupabaseClient,
    "fake-key",
    "pcm16",
    true,
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.sockets.length = 0;
  vi.clearAllMocks();
  mocks.rpc.mockImplementation(async (name: string) => ({
    data:
      name === "claim_voice_preparation"
        ? { id: "call", business_id: "business", status: "ringing" }
        : true,
    error: null,
  }));
  mocks.from.mockImplementation((table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      update: () => q,
      is: () => q,
      single: () => q,
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data:
            table === "businesses"
              ? { name: "Test" }
              : table === "voice_pilot_settings"
                ? { enabled: true, preparation_enabled: true }
                : { status: "ringing", phone_ended_at: null },
          error: null,
        }).then(resolve),
    };
    return q;
  });
});
afterEach(() => vi.useRealTimers());
describe("provider preparation", () => {
  it("does not open a model when the database denies preparation", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await manager().prepare("call");
    expect(mocks.sockets).toHaveLength(0);
  });
  it("prepares once and transfers the same socket, identity and cumulative usage", async () => {
    const p = manager();
    await p.prepare("call");
    await p.prepare("call");
    expect(mocks.sockets).toHaveLength(1);
    const socket = mocks.sockets[0] as TestSocket;
    start(socket);
    event(socket, { type: "session.usage.updated", usage: { seconds: 4 } });
    event(socket, { type: "session.usage.updated", usage: { seconds: 3 } });
    await vi.advanceTimersByTimeAsync(40);
    const prepared = p.take("call");
    expect(prepared?.socket).toBe(socket);
    expect(prepared?.seconds).toBe(4);
    expect(p.size).toBe(0);
    expect(p.take("call")).toBeNull();
    expect(socket.sent.filter((e) => e.type === "session.start")).toHaveLength(
      1,
    );
    const instructions = (socket.sent.find((e) => e.type === "session.start")?.session as { instructions: string }).instructions;
    expect(instructions).toContain("I’m Test’s AI assistant. How can I help you today?");
    expect(instructions).toContain("Small phrasing variations are welcome");
    expect(instructions).toContain("Wait silently for the application's fresh opening instruction");
    expect(instructions).toContain("Do not repeat the recording announcement");
    expect(socket.sent.some((e) => e.type === "session.instructions.append")).toBe(false);
    expect(
      socket.sent.some((e) => e.type === "session.input_audio.append"),
    ).toBe(true);
  });
  it("closes a preparation that never attaches and preserves final usage", async () => {
    const p = manager();
    await p.prepare("call");
    const socket = mocks.sockets[0] as TestSocket;
    start(socket);
    await vi.advanceTimersByTimeAsync(25020);
    expect(socket.sent.some((e) => e.type === "session.close")).toBe(true);
    expect(p.take("call")).toBeNull();
    event(socket, { type: "session.closed", usage: { seconds: 25.5 } });
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "update_voice_usage",
      expect.objectContaining({ p_seconds: 25.5, p_confirmed: true }),
    );
    expect(p.size).toBe(0);
  });
});
