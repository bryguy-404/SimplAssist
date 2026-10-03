import { describe, expect, it } from "vitest";
import { assertOwnedObject, assertTestObject, validateConfiguration } from "./review-stripe-release-e2e.mjs";

const valid = {
  REVIEW_STRIPE_E2E: "1",
  STRIPE_SECRET_KEY: "sk_test_fixtureOnly",
  REVIEW_STRIPE_E2E_SUPABASE_URL: "http://127.0.0.1:56321",
  REVIEW_STRIPE_E2E_SERVICE_ROLE_KEY: "local-fixture-only",
};

describe("review Stripe E2E mutation guards", () => {
  it("requires explicit disposable-resource authorization", () => {
    expect(() => validateConfiguration({ ...valid, REVIEW_STRIPE_E2E: "" })).toThrow("authorize");
  });
  it.each(["sk_live_fixture", "rk_test_fixture", " sk_test_fixture", "sk_test_fixture\n", ""])("rejects unsafe key %j before provider access", (key) => {
    expect(() => validateConfiguration({ ...valid, STRIPE_SECRET_KEY: key })).toThrow("sk_test_");
  });
  it.each([
    "https://production.supabase.co", "http://127.0.0.1.example.com:56321", "http://192.168.1.2:56321",
    "http://localhost", "http://localhost:56321/path", "http://user:pass@localhost:56321", "http://localhost:56321?project=prod",
  ])("rejects a non-isolated Supabase origin %s", (url) => {
    expect(() => validateConfiguration({ ...valid, REVIEW_STRIPE_E2E_SUPABASE_URL: url })).toThrow();
  });
  it("accepts only the explicit local key and normalized local origin", () => {
    expect(validateConfiguration(valid)).toEqual({ key: valid.STRIPE_SECRET_KEY, localUrl: valid.REVIEW_STRIPE_E2E_SUPABASE_URL, localKey: valid.REVIEW_STRIPE_E2E_SERVICE_ROLE_KEY });
    expect(() => validateConfiguration({ ...valid, REVIEW_STRIPE_E2E_SERVICE_ROLE_KEY: "" })).toThrow("local Supabase");
  });
  it.each([{ livemode: true }, {}, null])("rejects responses without affirmative test-mode evidence", (value) => {
    expect(() => assertTestObject(value)).toThrow();
  });
  it("refuses cleanup of resources that belong to another test run", () => {
    expect(() => assertOwnedObject({ livemode: false, metadata: { review_stripe_e2e_run: "someone-else" } }, "ours")).toThrow("not owned");
    expect(assertOwnedObject({ livemode: false, metadata: { review_stripe_e2e_run: "ours" } }, "ours").livemode).toBe(false);
  });
});
