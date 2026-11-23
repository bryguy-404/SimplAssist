import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: m }));
import { captureCallScreening, finishCallScreening, callFollowupAllowed } from "./calls.server";
beforeEach(() => { vi.resetAllMocks(); m.rpc.mockResolvedValue({ data: null, error: null }); });
describe("verified call evidence persistence", () => {
  it("stores exact business and call identities with a bounded verdict", async () => {
    await captureCallScreening("business", { call_control_id: "inbound", call_session_id: "session", from: "+12025550101", to: "+12025550102", call_screening_result: "spam_likely" });
    expect(m.rpc).toHaveBeenCalledWith("observe_inbound_call_screening", expect.objectContaining({ p_business: "business", p_control: "inbound", p_session: "session", p_caller: "+12025550101", p_called: "+12025550102", p_verdict: "spam_likely", p_evidence: "spam_likely" }));
  });
  it("does not terminate the inbound call when an outbound leg hangs up", async () => {
    await finishCallScreening({ call_control_id: "outbound", call_session_id: "shared", client_state: Buffer.from(JSON.stringify({ callControlId: "inbound", forwardingRole: "forward_target" })).toString("base64") });
    expect(m.rpc).toHaveBeenCalledWith("finish_inbound_call_screening", expect.objectContaining({ p_control: "outbound" }));
    m.rpc.mockClear();
    await finishCallScreening({ call_session_id: "shared", client_state: Buffer.from(JSON.stringify({ callControlId: "inbound", forwardingRole: "forward_target" })).toString("base64") });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("propagates persistence failure for webhook retry", async () => {
    m.rpc.mockResolvedValue({ error: { message: "DB unavailable" } });
    await expect(captureCallScreening("business", {})).rejects.toThrow("screening_event_save_failed");
    await expect(finishCallScreening({ call_control_id: "inbound" })).rejects.toThrow("screening_call_end_save_failed");
  });
  it.each(["unavailable", "unexpected", null])("fails closed on missing/unrecognized lookup %s", async data => {
    m.rpc.mockResolvedValue({ data, error: null });
    await expect(callFollowupAllowed({ businessId: "business", identity: "call", callerPhone: "+12025550101", expected: true })).rejects.toThrow("screening_followup_unavailable");
  });
  it("recognizes suppression and compatibility without guessing", async () => {
    m.rpc.mockResolvedValueOnce({ data: "suppressed" }).mockResolvedValueOnce({ data: "legacy" }).mockResolvedValueOnce({ data: "allowed" });
    const args = { businessId: "business", identity: "call", callerPhone: "+12025550101" };
    expect(await callFollowupAllowed(args)).toBe(false);
    expect(await callFollowupAllowed(args)).toBe(true);
    expect(await callFollowupAllowed(args)).toBe(true);
  });
});
