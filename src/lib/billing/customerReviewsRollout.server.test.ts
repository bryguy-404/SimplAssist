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
  it.each(["1", "0"])(
    "keeps an existing excluded account out of both broad and pilot access (global=%s)",
    (enabled) => {
      const environment = {
        CUSTOMERS_WORKSPACE_ENABLED: enabled,
        CUSTOMERS_WORKSPACE_BUSINESS_IDS: businessId,
        CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS: ` ${businessId.toUpperCase()} `,
      };
      expect(customerWorkspaceEnabled(businessId, environment)).toBe(false);
      expect(customerWorkspaceEnabled(otherId, environment)).toBe(enabled === "1");
    },
  );
  it("blocks rollout when the existing-account exclusion list is malformed", () => {
    expect(
      customerWorkspaceEnabled(businessId, {
        CUSTOMERS_WORKSPACE_ENABLED: "1",
        CUSTOMERS_WORKSPACE_BUSINESS_IDS: businessId,
        CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS: `${otherId},typo`,
      }),
    ).toBe(false);
  });
});
