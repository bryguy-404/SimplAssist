import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), send: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./service.server", () => ({ reviewRpc: mocks.rpc }));
vi.mock("@/lib/messaging/tenantSmsSend.server", () => ({
  sendTenantSms: mocks.send,
  TenantSmsSendError: class extends Error {
    constructor(
      public reason: string,
      public outcome: string,
    ) {
      super(reason);
    }
  },
}));
import { TenantSmsSendError } from "@/lib/messaging/tenantSmsSend.server";
import { runReviewSmsWorker } from "./sms-worker.server";
const job = {
  id: "40000000-0000-4000-a099-000000000001",
  business_id: "10000000-0000-4000-a099-000000000001",
  enrollment_id: "30000000-0000-4000-a099-000000000001",
  claim_token: "claim",
  kind: "initial",
  destination: "+15745550101",
  sender: "+15745550102",
  messaging_profile_id: "profile",
  body: "Honest review please. Reply STOP to opt out.",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REVIEWS_EMAIL_ENABLED", "1");
  vi.stubEnv("REVIEWS_EMAIL_PILOT_BUSINESS_IDS", job.business_id);
  vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
  vi.stubEnv("REVIEWS_SMS_PILOT_BUSINESS_IDS", job.business_id);
  vi.stubEnv("REVIEWS_SMS_SENDING_ENABLED", "1");
  mocks.rpc.mockImplementation(async (name: string) =>
    name === "review_claim_sms" ? [job] : name === "review_begin_sms" ? job : 0,
  );
});
afterEach(() => vi.unstubAllEnvs());
describe("SMS review dispatch", () => {
  it.each([
    "usage_limit_reached",
    "sms_usage_limit_reached",
    "sms_preflight_unavailable",
    "sms_reservation_unavailable",
    "plan_not_entitled",
    "sms_reviews_paused",
  ])("defers proven pre-provider admission denial %s", async (reason) => {
    mocks.send.mockRejectedValue(new TenantSmsSendError(reason, "not_sent"));
    await runReviewSmsWorker();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_finish_sms",
      expect.objectContaining({ p_outcome: "deferred", p_error: reason }),
    );
  });
  it("reconciles accepted receipts under kill switch without sending", async () => {
    vi.stubEnv("REVIEWS_SMS_SENDING_ENABLED", "0");
    expect(await runReviewSmsWorker()).toEqual({
      sent: 0,
      reconciled: 0,
      disabled: true,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("requires SMS and email pilot gates", async () => {
    vi.stubEnv("REVIEWS_SMS_PILOT_BUSINESS_IDS", "");
    await runReviewSmsWorker();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("passes a stable key to the shared metering and human-hold adapter", async () => {
    mocks.send.mockResolvedValue({
      data: { id: "provider" },
      reservationId: "reservation",
    });
    await runReviewSmsWorker();
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "review_invitation",
        reviewEnrollmentId: job.enrollment_id,
        idempotencyKey: `review-sms/v1/${job.id}`,
        text: job.body,
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_finish_sms",
      expect.objectContaining({
        p_outcome: "accepted",
        p_provider_id: "provider",
        p_reservation: "reservation",
      }),
    );
  });
  it("persists uncertain outcome and never retries in process", async () => {
    mocks.send.mockRejectedValue(
      new TenantSmsSendError("timeout", "uncertain"),
    );
    await runReviewSmsWorker();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_finish_sms",
      expect.objectContaining({ p_outcome: "uncertain", p_error: "timeout" }),
    );
  });
  it("does not invoke adapter without final admission", async () => {
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "review_claim_sms" ? [job] : null,
    );
    await runReviewSmsWorker();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
