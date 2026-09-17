import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sales from "@/lib/billing/planAvailability";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import BillingPlanChange, { billingChangeError, requestBillingChange } from "./BillingPlanChange";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("billing change review", () => {
  it("keeps a closed Full launch out of existing Growth purchase actions", () => {
    vi.spyOn(sales, "isPlanAvailable").mockImplementation((plan) => plan === "sms_only" || plan === "sms_and_chat");
    const html = renderToStaticMarkup(<BillingPlanChange currentPlan="sms_and_chat" active />);
    expect(html).not.toContain("Review Pro / Full Suite");
    expect(html).toContain("lower-priced plans begin at renewal");
  });
  it("offers the public Full upgrade for an active Growth account", () => {
    const html = renderToStaticMarkup(<BillingPlanChange currentPlan="sms_and_chat" active />);
    expect(html).toContain("Review Pro / Full Suite");
    expect(html).toContain("Review the price before confirming");
  });
  it("does not expose SMS plan switching to Chat Only", () => {
    expect(renderToStaticMarkup(<BillingPlanChange currentPlan="chat_only" active />)).toBe("");
  });
  it("serializes only the operation identity during confirmation", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ change: { state: "pending" } }) });
    vi.stubGlobal("fetch", fetch);
    await requestBillingChange("PATCH", { operationId: "saved", priceId: "untrusted", amountDueCents: 0 } as { operationId: string });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ operationId: "saved" });
  });
  it("explains uncertain outcomes without encouraging another charge", () => {
    expect(billingChangeError("sms_billing_recovery_required")).toContain("before starting another payment");
  });
});
