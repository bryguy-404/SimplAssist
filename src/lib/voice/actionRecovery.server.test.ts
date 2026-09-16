import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  from: vi.fn(),
  retrieve: vi.fn(),
  usage: vi.fn(),
  conversation: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: m.from } }));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: { messages: { retrieve: m.retrieve } },
}));
vi.mock("@/lib/billing/usage", () => ({ recordOutboundSmsUsage: m.usage }));
vi.mock("@/lib/ai/conversations", () => ({
  getOrCreateConversation: m.conversation,
}));
import { recoverVoiceActions } from "./actionRecovery.server";
let rows: Record<string, unknown>[];
let updates: { id: unknown; patch: Record<string, unknown> }[];
let ordering: unknown[][];
beforeEach(() => {
  vi.clearAllMocks();
  updates = [];
  ordering = [];
  rows = [
    {
      id: "unknown",
      kind: "signup",
      session_id: "session",
      status: "uncertain",
      updated_at: "2026-01-01T00:00:00Z",
      result: null,
    },
  ];
  m.from.mockImplementation((table: string) => {
    let patch: Record<string, unknown> | undefined, id: unknown;
    const q = {
      select: () => q,
      in: () => q,
      or: () => q,
      limit: () => q,
      order: (...args: unknown[]) => {
        ordering.push(args);
        return q;
      },
      eq: (key: string, value: unknown) => {
        if (key === "id") id = value;
        return q;
      },
      update: (value: Record<string, unknown>) => {
        patch = value;
        return q;
      },
      single: () => q,
      then: (resolve: (v: unknown) => unknown) => {
        if (patch) updates.push({ id, patch });
        return Promise.resolve({
          data:
            table === "voice_sessions"
              ? { called_phone: "+15555550102", caller_phone: "+15555550101" }
              : rows,
          error: null,
        }).then(resolve);
      },
    };
    return q;
  });
});
it("rotates unresolved sends without resubmitting them or blocking newer calls", async () => {
  await recoverVoiceActions();
  expect(m.retrieve).not.toHaveBeenCalled();
  expect(updates).toContainEqual({
    id: "unknown",
    patch: { reconciled_at: expect.any(String) },
  });
  expect(ordering[0]).toEqual(["reconciled_at", { nullsFirst: true }]);
});
it("verifies provider identity and records delivery independently of signup completion", async () => {
  rows = [
    {
      ...rows[0],
      id: "accepted",
      status: "succeeded",
      sms_logged_at: "2026-01-01",
      result: {
        providerMessageId: "message",
        summary: "Link accepted, signup incomplete",
      },
    },
  ];
  m.retrieve.mockResolvedValue({
    data: {
      from: { phone_number: "+15555550102" },
      to: [{ phone_number: "+15555550101", status: "delivered" }],
    },
  });
  await recoverVoiceActions();
  expect(updates).toContainEqual({
    id: "accepted",
    patch: expect.objectContaining({
      recovery_complete: true,
      result: expect.objectContaining({
        deliveryStatus: "delivered",
        summary: "Link accepted, signup incomplete",
      }),
    }),
  });
});
it("does not accept another recipient's delivery result and still rotates the failed lookup", async () => {
  rows = [
    {
      ...rows[0],
      id: "wrong",
      status: "succeeded",
      sms_logged_at: "2026-01-01",
      result: { providerMessageId: "message" },
    },
  ];
  m.retrieve.mockResolvedValue({
    data: {
      from: { phone_number: "+15555550102" },
      to: [{ phone_number: "+15555559999", status: "delivered" }],
    },
  });
  await recoverVoiceActions();
  expect(updates).toEqual([
    { id: "wrong", patch: { reconciled_at: expect.any(String) } },
  ]);
});
