import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { customerWorkspaceEnabled } from "./customerReviewsRollout.server";

const businessId = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";

describe("customer workspace rollout", () => {
  it("stays off until explicitly enabled without changing unrelated accounts", () => {
    expect(customerWorkspaceEnabled(businessId, {})).toBe(false);
    expect(
      customerWorkspaceEnabled(businessId, {
        CUSTOMERS_WORKSPACE_ENABLED: "true",
      }),
    ).toBe(false);
    expect(
      customerWorkspaceEnabled(businessId, {
        CUSTOMERS_WORKSPACE_ENABLED: "1",
      }),
    ).toBe(true);
    expect(
      customerWorkspaceEnabled("bad", { CUSTOMERS_WORKSPACE_ENABLED: "1" }),
    ).toBe(false);
  });
  it("admits only exact pilot UUIDs and fails closed on malformed configuration", () => {
    expect(
      customerWorkspaceEnabled(businessId, {
        CUSTOMERS_WORKSPACE_BUSINESS_IDS: ` ${businessId} `,
      }),
    ).toBe(true);
    expect(
      customerWorkspaceEnabled(otherId, {
        CUSTOMERS_WORKSPACE_BUSINESS_IDS: businessId,
      }),
    ).toBe(false);
    expect(
      customerWorkspaceEnabled(businessId, {
        CUSTOMERS_WORKSPACE_BUSINESS_IDS: `${businessId},typo`,
      }),
    ).toBe(false);
  });
});
