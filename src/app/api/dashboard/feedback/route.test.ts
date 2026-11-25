import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), rpc: vi.fn(), deliver: vi.fn() }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/feedback/delivery.server", () => ({ deliverFeedbackEmail: mocks.deliver }));
import { POST } from "./route";

const input = { action: "submit", id: "01000000-0000-4000-8000-000000000001", rating: "Okay", comment: "  Less scrolling  " };
const post = (body: unknown) => POST(new Request("https://example.test/api/dashboard/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({ ok: true, access: { user: { id: "owner", email: "owner@example.test" }, business: { id: "business" } } });
  mocks.rpc.mockResolvedValue({ data: "saved", error: null });
  mocks.deliver.mockResolvedValue(undefined);
});
it("saves against the signed-in account before attempting the email", async () => {
  expect((await post(input)).status).toBe(200);
  expect(mocks.rpc).toHaveBeenCalledWith("dashboard_feedback_action", { p_owner: "owner", p_business: "business", p_action: "submit",
    p_id: input.id, p_rating: "Okay", p_comment: "Less scrolling", p_email: "owner@example.test" });
  expect(mocks.deliver).toHaveBeenCalledWith(input.id);
});
it("leaves a saved response in the retry queue when the immediate send fails", async () => {
  mocks.deliver.mockRejectedValue(new Error("timeout"));
  expect(await (await post(input)).json()).toEqual({ result: "saved" });
});
it.each([{ ...input, businessId: "other" }, { ...input, comment: "x".repeat(1501) }, { ...input, rating: "invalid" }])("rejects invalid fields", async (body) => {
  expect((await post(body)).status).toBe(400);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it("requires an authenticated workspace and honors per-user rate limits", async () => {
  mocks.access.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 401 }) });
  expect((await post(input)).status).toBe(401);
  mocks.rpc.mockResolvedValueOnce({ data: "slow_down" });
  expect((await post(input)).status).toBe(429);
  expect(mocks.deliver).not.toHaveBeenCalled();
});
