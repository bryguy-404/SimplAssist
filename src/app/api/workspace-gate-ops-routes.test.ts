import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireWorkspaceRouteAccess: vi.fn(),
  createClient: vi.fn(),
  adminFrom: vi.fn(),
  searchAvailableNumbers: vi.fn(),
  getA2pRiskClearanceForBusiness: vi.fn(),
  registrationHasStartedForRisk: vi.fn(),
  screenA2pRiskForBusiness: vi.fn(),
  appendRegistrationEvent: vi.fn(),
  ensureUniqueSlug: vi.fn(),
  attemptPaidLaunch: vi.fn(),
  getOnboardingStateForOwner: vi.fn(),
  getOnboardingStateForBusinessId: vi.fn(),
  resolveSmsProvisioningAccess: vi.fn(),
}));

vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspaceRouteAccess: mocks.requireWorkspaceRouteAccess,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.adminFrom },
}));
vi.mock("@/lib/messaging/numbers", () => ({
  searchAvailableNumbers: mocks.searchAvailableNumbers,
}));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  getA2pRiskClearanceForBusiness: mocks.getA2pRiskClearanceForBusiness,
  registrationHasStartedForRisk: mocks.registrationHasStartedForRisk,
  screenA2pRiskForBusiness: mocks.screenA2pRiskForBusiness,
}));
vi.mock("@/lib/messaging/registration/audit", () => ({
  appendRegistrationEvent: mocks.appendRegistrationEvent,
  serializeError: vi.fn(),
}));
vi.mock("@/lib/util/slug.server", () => ({
  ensureUniqueSlug: mocks.ensureUniqueSlug,
}));
vi.mock("@/lib/billing/launch", () => ({
  attemptPaidLaunch: mocks.attemptPaidLaunch,
}));
vi.mock("@/lib/billing/entitlements", () => ({
  resolveSmsProvisioningAccess: mocks.resolveSmsProvisioningAccess,
}));
vi.mock("@/lib/onboarding/state", () => ({
  getOnboardingStateForOwner: mocks.getOnboardingStateForOwner,
  getOnboardingStateForBusinessId: mocks.getOnboardingStateForBusinessId,
}));

import { POST as purchaseNumber } from "./messaging/numbers/purchase/route";
import { GET as searchNumbers } from "./messaging/numbers/search/route";
import { POST as saveSmsUseCase } from "./onboarding/sms-use-case/route";
import { GET as getOnboardingState } from "./onboarding/state/route";
import { POST as submitRegistration } from "./onboarding/submit-registration/route";
import { POST as saveCompliance } from "./settings/compliance/route";

function request(path: string, body: unknown = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deny(status: 401 | 403 | 503) {
  const body =
    status === 401
      ? { error: "Unauthorized" }
      : status === 503
        ? { error: "workspace_access_unavailable", retryable: true }
        : { error: "workspace_access_denied" };

  mocks.requireWorkspaceRouteAccess.mockResolvedValue({
    ok: false,
    response: Response.json(body, { status }),
  });
  return body;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("operational API workspace gates", () => {
  it("gates number purchase before parsing, auth, risk, or database work", async () => {
    const expected = deny(403);
    const nextRequest = request("/api/messaging/numbers/purchase", {
      phoneNumber: "+13175550123",
    });
    const jsonSpy = vi.spyOn(nextRequest, "json");

    const response = await purchaseNumber(nextRequest);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expected);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
  });

  it("gates number search before validating input, auth, or Telnyx search", async () => {
    const expected = deny(403);
    const response = await searchNumbers(
      new NextRequest("http://localhost/api/messaging/numbers/search?areaCode=x"),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expected);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.searchAvailableNumbers).not.toHaveBeenCalled();
  });

  it("gates SMS-use-case writes before parsing, auth, or risk screening", async () => {
    const expected = deny(503);
    const nextRequest = request("/api/onboarding/sms-use-case");
    const jsonSpy = vi.spyOn(nextRequest, "json");

    const response = await saveSmsUseCase(nextRequest);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expected);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.adminFrom).not.toHaveBeenCalled();
    expect(mocks.screenA2pRiskForBusiness).not.toHaveBeenCalled();
  });

  it("preserves the adapter's unauthenticated response before state reads", async () => {
    const expected = deny(401);

    const response = await getOnboardingState();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(expected);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStateForOwner).not.toHaveBeenCalled();
  });

  it("keeps mid-onboarding configuration reads available for an operationally suspended workspace", async () => {
    const user = { id: "owner-1", email: "owner@example.test" };
    const state = {
      businessId: "business-1",
      currentStep: "business_info",
      dashboardReady: false,
    };
    mocks.requireWorkspaceRouteAccess.mockResolvedValue({
      ok: true,
      access: {
        status: "resolved",
        user,
        business: {
          id: "business-1",
          partner_id: null,
          billing_mode: "stripe",
          operations_suspended_at: "2026-08-04T12:00:00.000Z",
          ai_replies_paused_at: "2026-08-04T12:01:00.000Z",
          texting_paused_at: "2026-08-04T12:02:00.000Z",
          bookings_paused_at: "2026-08-04T12:03:00.000Z",
        },
        hostKind: "canonical",
      },
    });
    mocks.createClient.mockResolvedValue({
      auth: {
        getUser: vi.fn(async () => ({ data: { user }, error: null })),
      },
    });
    mocks.getOnboardingStateForOwner.mockResolvedValue(state);

    const response = await getOnboardingState();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state });
    expect(mocks.getOnboardingStateForOwner).toHaveBeenCalledWith(user.id);
    expect(mocks.adminFrom).not.toHaveBeenCalled();
    expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).not.toHaveBeenCalled();
  });

  it("gates registration submission before auth, launch, or state reads", async () => {
    const expected = deny(403);

    const response = await submitRegistration();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expected);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStateForBusinessId).not.toHaveBeenCalled();
  });

  it("gates compliance writes before parsing, auth, fetch, or admin writes", async () => {
    const expected = deny(403);
    const nextRequest = request("/api/settings/compliance", { mode: "hosted" });
    const jsonSpy = vi.spyOn(nextRequest, "json");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await saveCompliance(nextRequest);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expected);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });
});
