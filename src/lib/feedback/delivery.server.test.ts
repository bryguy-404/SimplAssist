import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), send: vi.fn(), update: vi.fn(), eq: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/client", () => ({ resend: { emails: { send: mocks.send } }, RESEND_FROM: "notifications@example.test" }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mocks.rpc, from: () => ({ update: mocks.update }) } }));
import { deliverFeedbackEmail } from "./delivery.server";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValue({ data: [{ id: "response", business_name: "Test Shop", reply_email: "owner@example.test", rating: "Great", comment: "Fast setup" }] });
  mocks.update.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockResolvedValue({ error: null });
  mocks.send.mockResolvedValue({ data: { id: "provider-id" }, error: null });
});

it("sends the rating, comment and business to Bryan with a stable retry key", async () => {
  await deliverFeedbackEmail("response");
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: "bryan@simplassist.com", replyTo: "owner@example.test",
    text: "Business: Test Shop\nFrom: owner@example.test\nRating: Great\n\nFast setup" }),
    expect.objectContaining({ idempotencyKey: "dashboard-feedback/response" }));
  expect(mocks.eq).toHaveBeenCalledWith("id", "response");
});

it("keeps unconfirmed mail available for retry and skips already claimed responses", async () => {
  mocks.send.mockResolvedValue({ error: { name: "rate_limit_exceeded" } });
  await expect(deliverFeedbackEmail()).rejects.toThrow("unconfirmed");
  mocks.rpc.mockResolvedValue({ data: [] });
  await deliverFeedbackEmail();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledOnce();
});
