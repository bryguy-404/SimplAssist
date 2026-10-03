import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./service.server", () => ({ reviewRpc: mocks.rpc }));
import { signReviewToken } from "./domain";
import {
  GET as unsubscribeGet,
  POST as unsubscribePost,
} from "@/app/reviews/unsubscribe/[token]/route";
import {
  GET as verifyGet,
  POST as verifyPost,
} from "@/app/reviews/verify-reply-to/[token]/route";
const id = "10000000-0000-4000-a096-000000000001";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REVIEWS_LINK_SECRET", "a".repeat(32));
});
afterEach(() => vi.unstubAllEnvs());
describe("scanner-safe public actions", () => {
  it("GET unsubscribe renders confirmation without writing", async () => {
    const response = await unsubscribeGet(
      new Request("https://simplassist.com"),
      { params: { token: signReviewToken(id, "unsubscribe") } },
    );
    expect(await response.text()).toContain('form method="post"');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("RFC8058 POST records unsubscribe and returns200", async () => {
    mocks.rpc.mockResolvedValue(true);
    const response = await unsubscribePost(
      new Request("https://simplassist.com", {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
      }),
      { params: { token: signReviewToken(id, "unsubscribe") } },
    );
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("review_unsubscribe", { p_id: id });
  });
  it("GET verification cannot consume verification tokens", async () => {
    await verifyGet(new Request("https://simplassist.com"), {
      params: { token: signReviewToken(id, "reply_to") },
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects wrong action tokens before DB mutation", async () => {
    const response = await verifyPost(
      new Request("https://simplassist.com", { method: "POST" }),
      { params: { token: signReviewToken(id, "review") } },
    );
    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
