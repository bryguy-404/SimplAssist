import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Telnyx from "telnyx";
import { maintainVoicePilot } from "./maintenance";

function harness(rows: unknown[][], cleanup: unknown[] = []) {
  const writes: { table: string; value: unknown }[] = [];
  const from = vi.fn((table: string) => {
    const result = { data: rows.shift() ?? [], error: null };
    const q = {
      select() {
        return this;
      },
      eq() {
        return this;
      },
      neq() {
        return this;
      },
      lt() {
        return this;
      },
      is() {
        return this;
      },
      not() {
        return this;
      },
      or() {
        return this;
      },
      limit() {
        return this;
      },
      update(value: unknown) {
        writes.push({ table, value });
        return this;
      },
      upsert(value: unknown) {
        writes.push({ table, value });
        return this;
      },
      then(resolve: (result: unknown) => void) {
        return Promise.resolve(result).then(resolve);
      },
    };
    return q;
  });
  const rpc = vi.fn(async (name: string, ...args: unknown[]) => {
    void args;
    return {
      data: name === "claim_voice_recording_cleanup" ? cleanup : null,
      error: null,
    };
  });
  const hangup = vi.fn().mockResolvedValue({});
  const list = vi.fn().mockResolvedValue({ data: [] });
  const remove = vi.fn().mockResolvedValue({});
  const fallback = vi.fn().mockResolvedValue(undefined);
  return {
    writes,
    rpc,
    hangup,
    list,
    remove,
    fallback,
    run: () =>
      maintainVoicePilot(
        { from, rpc } as unknown as SupabaseClient,
        {
          calls: { actions: { hangup } },
          recordings: { list, delete: remove },
        } as unknown as Telnyx,
        fallback,
      ),
  };
}

describe("durable voice maintenance", () => {
  it("does not finalize or request fallback when a stale worker recovers before its claim", async () => {
    const h = harness([
      [{ id: "recovered", response_mode: "voice" }],
      [],
      [],
      [],
      [],
    ]);
    await h.run();
    expect(
      h.rpc.mock.calls.some(([name]) => name === "finalize_voice_session"),
    ).toBe(false);
    expect(h.hangup).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
  });
  it("keeps failed audio deletion retryable while finalizing successful deletes and pending fallback", async () => {
    const h = harness(
      [[], [], [], [{ id: "failed-call" }]],
      [
        { recording_id: "retry", lease_token: "a" },
        { recording_id: "gone", lease_token: "b" },
      ],
    );
    h.remove.mockImplementation(async (id: string) => {
      if (id === "retry") throw { status: 503 };
      throw { status: 404 };
    });
    await h.run();
    expect(h.rpc).toHaveBeenCalledWith("finish_voice_recording_cleanup", {
      p_recording_id: "retry",
      p_lease: "a",
      p_success: false,
      p_error: "telnyx_delete_failed",
    });
    expect(h.rpc).toHaveBeenCalledWith("finish_voice_recording_cleanup", {
      p_recording_id: "gone",
      p_lease: "b",
      p_success: true,
      p_error: null,
    });
    expect(h.fallback).toHaveBeenCalledOnce();
    expect(h.fallback).toHaveBeenCalledWith("failed-call");
  });
  it("rejects recordings from another call and retains the original call's 30-day expiry", async () => {
    const h = harness([
      [],
      [],
      [
        {
          id: "call",
          business_id: "business",
          call_control_id: "control",
          call_session_id: "telnyx-call",
          created_at: "2026-09-01T00:00:00Z",
        },
      ],
      [],
      [],
      [],
    ]);
    h.list.mockResolvedValue({
      data: [
        { id: "wrong", call_control_id: "control", call_session_id: "other" },
        {
          id: "right",
          call_control_id: "control",
          call_session_id: "telnyx-call",
        },
      ],
    });
    await h.run();
    expect(
      h.writes.filter((write) => write.table === "voice_recordings"),
    ).toEqual([
      {
        table: "voice_recordings",
        value: {
          recording_id: "right",
          session_id: "call",
          business_id: "business",
          delete_after: "2026-10-01T00:00:00.000Z",
        },
      },
    ]);
  });
});
