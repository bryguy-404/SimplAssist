import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), send: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/client", () => ({
  resend: { emails: { send: mocks.send } },
}));
vi.mock("./service.server", () => ({ reviewRpc: mocks.rpc }));
import { classifyResendResult, runReviewEmailWorker } from "./worker.server";
const job = {
  id: "40000000-0000-4000-a096-000000000001",
  business_id: "10000000-0000-4000-a096-000000000001",
  claim_token: "claim",
  idempotency_key: "review-email/v1/40000000-0000-4000-a096-000000000001",
  payload: {
    from: "sender@example.com",
    to: ["customer@example.com"],
    subject: "Review",
    text: "Honest review",
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REVIEWS_EMAIL_ENABLED", "1");
  vi.stubEnv("REVIEWS_EMAIL_PILOT_BUSINESS_IDS", job.business_id);
  vi.stubEnv("REVIEWS_EMAIL_SENDING_ENABLED", "1");
  mocks.rpc.mockImplementation(async (name: string) =>
    name === "review_claim_emails"
      ? [job]
      : name === "review_begin_email"
        ? job
        : name === "review_apply_email_events"
          ? 0
          : null,
  );
});
afterEach(() => vi.unstubAllEnvs());
describe("durable review dispatch", () => {
  it.each([
    "rate_limit_exceeded",
    "daily_quota_exceeded",
    "monthly_quota_exceeded",
    "invalid_api_key",
  ])(
    "defers temporary provider failure %s instead of stopping the customer",
    async (name) => {
      mocks.send.mockResolvedValue({ data: null, error: { name } });
      await runReviewEmailWorker();
      expect(mocks.rpc).toHaveBeenCalledWith(
        "review_finish_email",
        expect.objectContaining({ p_outcome: "deferred", p_error: name }),
      );
    },
  );
  it("processes late events under kill switch without claiming or sending", async () => {
    vi.stubEnv("REVIEWS_EMAIL_SENDING_ENABLED", "0");
    expect(await runReviewEmailWorker()).toEqual({
      sent: 0,
      applied: 0,
      disabled: true,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("requires tenant pilot even if a DB job was claimed", async () => {
    vi.stubEnv("REVIEWS_EMAIL_PILOT_BUSINESS_IDS", "");
    await runReviewEmailWorker();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "review_begin_email",
      expect.anything(),
    );
  });
  it("never calls provider when final admission refuses", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "review_claim_emails" ? [job] : null,
    );
    await runReviewEmailWorker();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("uses frozen payload, stable key and delivery correlation; persists acceptance", async () => {
    mocks.send.mockResolvedValue({ data: { id: "email123" }, error: null });
    expect((await runReviewEmailWorker()).sent).toBe(1);
    expect(mocks.send).toHaveBeenCalledWith(
      { ...job.payload, tags: [{ name: "review_delivery", value: job.id }] },
      expect.objectContaining({ idempotencyKey: job.idempotency_key }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("review_finish_email", {
      p_id: job.id,
      p_claim: "claim",
      p_outcome: "accepted",
      p_provider_id: "email123",
      p_error: null,
    });
  });
  it("persists ambiguous transport results without issuing a second send in-process", async () => {
    mocks.send.mockRejectedValue(new Error("socket closed"));
    await runReviewEmailWorker();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_finish_email",
      expect.objectContaining({ p_outcome: "ambiguous", p_provider_id: null }),
    );
  });
  it("treats only known rejection names as definite no-send", () => {
    expect(classifyResendResult({ name: "validation_error" })).toBe(
      "definite_failure",
    );
    expect(classifyResendResult({ name: "application_error" })).toBe(
      "ambiguous",
    );
    expect(classifyResendResult({ name: "new_provider_error" })).toBe(
      "ambiguous",
    );
  });
});
