import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), inspect: vi.fn(), prepare: vi.fn(), corrected: vi.fn(), reauthorize: vi.fn(), execute: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/auth", () => ({ getAdminUser: mocks.admin }));
vi.mock("@/lib/reviews/campaignRetry.server", () => ({
  inspectReviewCampaignRetry: mocks.inspect,
  prepareReviewCampaignRetry: mocks.prepare,
  prepareCorrectedReviewCampaignRetry: mocks.corrected,
  reauthorizeReviewCampaignRetry: mocks.reauthorize,
  executeReviewCampaignRetry: mocks.execute,
}));

import { ReviewSmsError } from "@/lib/billing/reviewSms";
import { GET, POST } from "./route";

const businessId = "0e2bf188-ab53-4d3b-8e1a-7aac49125811";
const accountId = "10000000-0000-4000-a100-000000000001";
const ownerId = "20000000-0000-4000-a100-000000000001";
const actorId = "30000000-0000-4000-a100-000000000001";
const attemptId = "40000000-0000-4000-a100-000000000001";
const reservationId = "50000000-0000-4000-a100-000000000001";
const token = "60000000-0000-4000-a100-000000000001";
const origin = "https://simplassist.test";
const path = "/api/admin/reviews/sms/campaign-retry";
const preparation = { action: "prepare", businessId, ownerId, accountId, originalReservationId: reservationId,
  originalPayloadHash: "a".repeat(64), membershipRevision: 2, acceptAdditionalFee: true };
const execution = { action: "execute", businessId, attemptId, token };
const reauthorization = { ...preparation, action: "reauthorize", attemptId, authorizationRevision: 1 };
const inspection = { businessId, eligible: true, attempts: [] };
const request = (body: unknown, extraHeaders: Record<string, string> = {}) => new NextRequest(`${origin}${path}`, {
  method: "POST",
  headers: { host: "simplassist.test", origin, "content-type": "application/json", ...extraHeaders },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
  mocks.admin.mockResolvedValue({ id: actorId });
  mocks.inspect.mockResolvedValue(inspection);
  mocks.prepare.mockResolvedValue({ attemptId, token, expiresAt: "2026-10-06T04:15:00Z" });
  mocks.corrected.mockResolvedValue({ attemptId, token, expiresAt: "2026-10-06T04:15:00Z" });
  mocks.reauthorize.mockResolvedValue({ attemptId, token, expiresAt: "2026-10-06T04:15:00.000Z" });
  mocks.execute.mockResolvedValue({ ...inspection, eligible: false });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("admin campaign retry GET", () => {
  it("authenticates before parsing identifiers or accessing inspection data", async () => {
    mocks.admin.mockResolvedValue(null);
    const response = await GET(new NextRequest(`${origin}${path}?businessId=invalid`));
    expect(response.status).toBe(404);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("only inspects and marks the response private and uncacheable", async () => {
    const response = await GET(new NextRequest(`${origin}${path}?businessId=${businessId}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inspection });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(businessId);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects invalid account IDs before inspection", async () => {
    expect((await GET(new NextRequest(`${origin}${path}?businessId=invalid`))).status).toBe(400);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("preserves a disabled pilot's 404 without exposing provider details", async () => {
    mocks.inspect.mockRejectedValue(new ReviewSmsError("review_sms_campaign_retry_disabled", 404));
    const response = await GET(new NextRequest(`${origin}${path}?businessId=${businessId}`));
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("review_sms_campaign_retry_disabled");
  });
});

describe("admin campaign retry POST", () => {
  it("uses a distinct corrected preparation action and the authenticated admin without submitting", async () => {
    const input = { ...preparation, action: "prepare_corrected" };
    const result = await POST(request(input));
    expect(result.status).toBe(200);
    expect(mocks.corrected).toHaveBeenCalledExactlyOnceWith({ ...input, actorId });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { acceptAdditionalFee: false }, { acceptAdditionalFee: undefined }, { actorId: ownerId },
    { membershipRevision: 0 }, { originalPayloadHash: "invalid" }, { filing: { arbitrary: true } },
  ])("rejects invalid corrected preparation fields %#", async extra => {
    expect((await POST(request({ ...preparation, action: "prepare_corrected", ...extra }))).status).toBe(400);
    expect(mocks.corrected).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("denies corrected preparation without an admin session", async () => {
    mocks.admin.mockResolvedValue(null);
    expect((await POST(request({ ...preparation, action: "prepare_corrected" }))).status).toBe(404);
    expect(mocks.corrected).not.toHaveBeenCalled();
  });

  it("denies cross-origin corrected preparation", async () => {
    expect((await POST(request({ ...preparation, action: "prepare_corrected" }, { origin: "https://foreign.test" }))).status).toBe(403);
    expect(mocks.corrected).not.toHaveBeenCalled();
  });

  it("reauthorizes the same attempt using the authenticated actor and the exact inspected revision", async () => {
    const response = await POST(request(reauthorization));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorization: { attemptId, token, expiresAt: "2026-10-06T04:15:00.000Z" } });
    expect(mocks.reauthorize).toHaveBeenCalledExactlyOnceWith({ ...reauthorization, actorId });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    { ...reauthorization, authorizationRevision: 0 }, { ...reauthorization, authorizationRevision: 1.5 },
    { ...reauthorization, authorizationRevision: undefined }, { ...reauthorization, attemptId: "invalid" },
    { ...reauthorization, actorId: ownerId }, { ...reauthorization, token },
    { ...reauthorization, acceptAdditionalFee: false }, { ...reauthorization, acceptAdditionalFee: undefined },
    { ...reauthorization, originalPayloadHash: "invalid" }, { ...reauthorization, membershipRevision: 0 },
  ])("strictly validates reauthorization acknowledgement and compare-and-swap fields %#", async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.reauthorize).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not permit an ordinary session to replace the retry capability", async () => {
    mocks.admin.mockResolvedValue(null);
    expect((await POST(request(reauthorization))).status).toBe(404);
    expect(mocks.reauthorize).not.toHaveBeenCalled();
  });

  it.each([
    [{ host: "foreign.test" }, 404], [{ origin: "https://foreign.test" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403], [{ "content-type": "text/plain" }, 400],
  ] as const)("applies the same admin mutation boundary to reauthorization %#", async (headers, status) => {
    expect((await POST(request(reauthorization, headers))).status).toBe(status);
    expect(mocks.reauthorize).not.toHaveBeenCalled();
  });

  it("does not auto-repeat a reauthorization whose compare-and-swap revision is stale", async () => {
    mocks.reauthorize.mockRejectedValue(new ReviewSmsError("review_sms_campaign_retry_changed"));
    expect((await POST(request(reauthorization))).status).toBe(409);
    expect(mocks.reauthorize).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects a non-admin before reading malformed JSON", async () => {
    mocks.admin.mockResolvedValue(null);
    const response = await POST(new NextRequest(`${origin}${path}`, { method: "POST", body: "invalid" }));
    expect(response.status).toBe(404);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    [{ host: "foreign.test" }, 404],
    [{ origin: "https://foreign.test" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403],
    [{ "content-type": "text/plain" }, 400],
  ] as const)("enforces the existing same-origin admin mutation boundary %#", async (headers, status) => {
    expect((await POST(request(preparation, headers))).status).toBe(status);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...preparation, acceptAdditionalFee: false },
    { ...preparation, actorId: ownerId },
    { ...preparation, ownerId: "invalid" },
    { ...preparation, originalPayloadHash: "invalid" },
    { ...preparation, membershipRevision: 0 },
    { ...execution, token: "invalid" },
    { ...execution, extra: "ignored?" },
    { ...execution, action: "resubmit" },
  ])("rejects malformed or unacknowledged mutation requests %#", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("prepares under the authenticated actor without executing the provider call", async () => {
    const response = await POST(request(preparation));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorization: { attemptId, token, expiresAt: "2026-10-06T04:15:00Z" } });
    expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith({ ...preparation, actorId });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("executes only the exact authorized attempt and token", async () => {
    const response = await POST(request(execution));
    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(execution);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ inspection: { ...inspection, eligible: false } });
  });

  it("returns a safe failure and does not repeat execution after a provider exception", async () => {
    mocks.execute.mockRejectedValue(new Error("Provider failure private@example.com 12-3456789 Bearer SECRET"));
    const response = await POST(request(execution));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("review_sms_campaign_retry_unavailable");
    expect(JSON.stringify(body)).not.toContain("private@example.com");
    expect(JSON.stringify(body)).not.toContain("SECRET");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("returns the known conflict code while suppressing private diagnostics", async () => {
    mocks.prepare.mockRejectedValue(new ReviewSmsError("review_sms_campaign_retry_changed"));
    const response = await POST(request(preparation));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("review_sms_campaign_retry_changed");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"])("%s never logs unknown provider errors a second time without private-value context", async (method) => {
    const privateValue = "63 Willow Place";
    const providerError = Object.assign(new Error(`Provider rejected ${privateValue}`), {
      status: 400,
      error: { errors: [{ detail: `The filing contained ${privateValue}`, code: "501" }] },
    });
    mocks.inspect.mockRejectedValue(providerError);
    mocks.execute.mockRejectedValue(providerError);
    const response = method === "GET"
      ? await GET(new NextRequest(`${origin}${path}?businessId=${businessId}`))
      : await POST(request(execution));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(privateValue);
    const logCalls = vi.mocked(console.error).mock.calls;
    expect(logCalls).toHaveLength(1);
    expect(JSON.stringify(logCalls)).not.toContain(privateValue);
    expect(JSON.parse(logCalls[0][1] as string).error).toMatchObject({
      message: "review_sms_campaign_retry_unavailable", status: null, providerErrors: [],
    });
  });
});
