import { describe, expect, it } from "vitest";
import { isBrandVerificationPendingResponse } from "./pendingBrand";

describe("pending brand classification", () => {
  it("recognizes only the pending-brand 400 response, including the nested SDK shape", () => {
    expect(isBrandVerificationPendingResponse({ status: 400, error: [{ code: 527 }] })).toBe(true);
    expect(isBrandVerificationPendingResponse({ status: 400, error: { errors: [{ code: "527" }] } })).toBe(true);
  });
  it.each([new Error("Brand registration status pending"), null,
    { status: 500, error: [{ code: 527 }] }, { status: 400, error: [] },
    { status: 400, error: [{ code: 527 }, { code: 999 }] },
    { status: 400, error: [{ code: 501, description: "Brand rejected" }] },
  ])("does not hide a different or ambiguous failure: %j", (error) => {
    expect(isBrandVerificationPendingResponse(error)).toBe(false);
  });
});
