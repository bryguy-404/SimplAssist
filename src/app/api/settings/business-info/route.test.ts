import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adminFrom: vi.fn(),
  requireWorkspaceRouteAccess: vi.fn(),
  stateSelect: vi.fn(),
  stateEq: vi.fn(),
  stateIs: vi.fn(),
  stateMaybeSingle: vi.fn(),
  businessUpdate: vi.fn(),
  updateEq: vi.fn(),
  updateIs: vi.fn(),
  updateSelect: vi.fn(),
  updateMaybeSingle: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspaceRouteAccess: mocks.requireWorkspaceRouteAccess,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.adminFrom },
}));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  registrationHasStartedForRisk: (business: {
    telnyx_brand_id: string | null;
    brand_status: string | null;
    campaign_status: string | null;
    onboarding_registration_status: string | null;
  }) =>
    Boolean(
      business.telnyx_brand_id ||
        business.brand_status ||
        business.campaign_status ||
        business.onboarding_registration_status === "submitted"
    ),
}));

import {
  REGISTRATION_STATE_UNAVAILABLE_CODE,
  REGISTRATION_STATE_UNAVAILABLE_MESSAGE,
  BUSINESS_ADDRESS_LOCK_COPY,
  SETTINGS_REGISTRATION_LOCK_CODE,
  SETTINGS_STATE_CHANGED_CODE,
  SETTINGS_STATE_CHANGED_MESSAGE,
} from "@/lib/settings/registrationLockCopy";
import { SETTINGS_REGISTRATION_STATE_COLUMNS } from "@/lib/settings/registrationLock.server";
import { POST } from "./route";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BUSINESS_ID = "00000000-0000-4000-8000-000000000002";

const pristineRegistrationState = {
  telnyx_brand_id: null,
  brand_status: null,
  campaign_status: null,
  onboarding_registration_status: "not_started",
  shared_registration_id: null,
};

const fullRequest = {
  phoneNumber: "  (317) 555-0100  ",
  address: " 123 Main Street ",
  city: " Indianapolis ",
  state: " indiana ",
  zip: " 46204 ",
};

const stateLookupChain = {
  eq: mocks.stateEq,
  is: mocks.stateIs,
  maybeSingle: mocks.stateMaybeSingle,
};

const updateChain = {
  eq: mocks.updateEq,
  is: mocks.updateIs,
  select: mocks.updateSelect,
  maybeSingle: mocks.updateMaybeSingle,
};

const businessTable = {
  select: mocks.stateSelect,
  update: mocks.businessUpdate,
};

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/settings/business-info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeRawRequest(body: string) {
  return new NextRequest("http://localhost/api/settings/business-info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.requireWorkspaceRouteAccess.mockResolvedValue({
    ok: true,
    access: {
      user: { id: USER_ID },
      business: { id: BUSINESS_ID },
    },
  });
  mocks.adminFrom.mockReturnValue(businessTable);
  mocks.stateSelect.mockReturnValue(stateLookupChain);
  mocks.stateEq.mockReturnValue(stateLookupChain);
  mocks.stateIs.mockReturnValue(stateLookupChain);
  mocks.stateMaybeSingle.mockResolvedValue({
    data: pristineRegistrationState,
    error: null,
  });
  mocks.businessUpdate.mockReturnValue(updateChain);
  mocks.updateEq.mockReturnValue(updateChain);
  mocks.updateIs.mockReturnValue(updateChain);
  mocks.updateSelect.mockReturnValue(updateChain);
  mocks.updateMaybeSingle.mockResolvedValue({
    data: { id: BUSINESS_ID },
    error: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/settings/business-info", () => {
  it("returns a workspace denial before JSON parsing or database access", async () => {
    mocks.requireWorkspaceRouteAccess.mockResolvedValue({
      ok: false,
      response: Response.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      ),
    });
    const request = makeRequest({ phoneNumber: "(317) 555-0100" });
    const jsonSpy = vi.spyOn(request, "json");

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "workspace_access_denied" });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before database access", async () => {
    const response = await POST(makeRawRequest("{"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("returns 401 before parsing or database access without a workspace user", async () => {
    mocks.requireWorkspaceRouteAccess.mockResolvedValue({
      ok: true,
      access: { user: null, business: { id: BUSINESS_ID } },
    });
    const request = makeRequest({ phoneNumber: "(317) 555-0100" });
    const jsonSpy = vi.spyOn(request, "json");

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty payload", {}],
    [
      "a client-supplied business id",
      { phoneNumber: "(317) 555-0100", businessId: BUSINESS_ID },
    ],
    [
      "a partial full update",
      {
        phoneNumber: "(317) 555-0100",
        address: "123 Main Street",
        city: "Indianapolis",
        state: "IN",
      },
    ],
    [
      "an extra full-update field",
      { ...fullRequest, unexpected: true },
    ],
  ])("rejects %s", async (_description, body) => {
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid input" });
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("validates phone-only updates before writing", async () => {
    const response = await POST(makeRequest({ phoneNumber: "555-0100" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid input",
      details: {
        phoneNumber: "Enter a valid business contact phone number",
      },
    });
    expect(mocks.adminFrom).not.toHaveBeenCalled();
  });

  it("allows a phone-only write with an exact registration snapshot", async () => {
    const response = await POST(
      makeRequest({ phoneNumber: "  (317) 555-0199  " })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.stateSelect).toHaveBeenCalledExactlyOnceWith(
      `${SETTINGS_REGISTRATION_STATE_COLUMNS}, shared_registration_id`
    );
    expect(mocks.businessUpdate).toHaveBeenCalledExactlyOnceWith({
      phone_number: "(317) 555-0199",
    });
    expect(mocks.updateEq.mock.calls).toEqual([
      ["id", BUSINESS_ID],
      ["owner_id", USER_ID],
      ["onboarding_registration_status", "not_started"],
    ]);
    expect(mocks.updateIs.mock.calls).toEqual([
      ["deleted_at", null],
      ["telnyx_brand_id", null],
      ["brand_status", null],
      ["campaign_status", null],
      ["shared_registration_id", null],
    ]);
  });

  it.each([
    ["brand", { brand_status: "rejected" }],
    ["campaign", { campaign_status: "rejected" }],
  ])(
    "keeps a failed %s rejection locked for a phone-only update",
    async (_label, rejection) => {
      mocks.stateMaybeSingle.mockResolvedValue({
        data: {
          ...pristineRegistrationState,
          ...rejection,
          telnyx_brand_id: "brand-1",
          onboarding_registration_status: "failed",
        },
        error: null,
      });

      const response = await POST(
        makeRequest({ phoneNumber: "(317) 555-0199" })
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        code: SETTINGS_REGISTRATION_LOCK_CODE,
        error:
          "Contact support to change your business contact phone because it was filed with your carrier registration.",
      });
      expect(mocks.businessUpdate).not.toHaveBeenCalled();
    }
  );

  it("returns the phone lock when its guarded save loses to a rejection", async () => {
    mocks.updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.stateMaybeSingle
      .mockResolvedValueOnce({ data: pristineRegistrationState, error: null })
      .mockResolvedValueOnce({
        data: {
          ...pristineRegistrationState,
          campaign_status: "rejected",
          onboarding_registration_status: "failed",
        },
        error: null,
      });

    const response = await POST(
      makeRequest({ phoneNumber: "(317) 555-0199" })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: SETTINGS_REGISTRATION_LOCK_CODE,
      error:
        "Contact support to change your business contact phone because it was filed with your carrier registration.",
    });
    expect(mocks.stateMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("normalizes and saves a full unlocked update with an exact state snapshot", async () => {
    const response = await POST(makeRequest(fullRequest));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.stateSelect).toHaveBeenCalledExactlyOnceWith(
      `${SETTINGS_REGISTRATION_STATE_COLUMNS}, shared_registration_id`
    );
    expect(mocks.stateEq.mock.calls).toEqual([
      ["id", BUSINESS_ID],
      ["owner_id", USER_ID],
    ]);
    expect(mocks.stateIs).toHaveBeenCalledExactlyOnceWith("deleted_at", null);
    expect(mocks.businessUpdate).toHaveBeenCalledExactlyOnceWith({
      phone_number: "(317) 555-0100",
      address: "123 Main Street",
      city: "Indianapolis",
      state: "IN",
      zip: "46204",
    });
    expect(mocks.updateEq.mock.calls).toEqual([
      ["id", BUSINESS_ID],
      ["owner_id", USER_ID],
      ["onboarding_registration_status", "not_started"],
    ]);
    expect(mocks.updateIs.mock.calls).toEqual([
      ["deleted_at", null],
      ["telnyx_brand_id", null],
      ["brand_status", null],
      ["campaign_status", null],
      ["shared_registration_id", null],
    ]);
  });

  it("rejects a full update with the exact address lock response", async () => {
    mocks.stateMaybeSingle.mockResolvedValue({
      data: {
        ...pristineRegistrationState,
        telnyx_brand_id: "brand-1",
        onboarding_registration_status: "submitted",
      },
      error: null,
    });

    const response = await POST(makeRequest(fullRequest));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: SETTINGS_REGISTRATION_LOCK_CODE,
      error: BUSINESS_ADDRESS_LOCK_COPY.message,
    });
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });

  it.each(["not_started", "failed"])("keeps the shared canonical address locked before brand binding (%s)", async (status) => {
    mocks.stateMaybeSingle.mockResolvedValue({ data: { ...pristineRegistrationState,
      shared_registration_id: "registration", onboarding_registration_status: status }, error: null });
    const response = await POST(makeRequest(fullRequest));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: SETTINGS_REGISTRATION_LOCK_CODE, error: BUSINESS_ADDRESS_LOCK_COPY.message });
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });

  it("still permits an account-specific phone-only update for a staged shared registration", async () => {
    mocks.stateMaybeSingle.mockResolvedValue({ data: { ...pristineRegistrationState,
      shared_registration_id: "registration" }, error: null });
    const response = await POST(makeRequest({ phoneNumber: "(317) 555-0199" }));
    expect(response.status).toBe(200);
    expect(mocks.businessUpdate).toHaveBeenCalledExactlyOnceWith({ phone_number: "(317) 555-0199" });
    expect(mocks.updateEq).toHaveBeenCalledWith("shared_registration_id", "registration");
  });

  it("guards a full address save against shared staging that starts after the read", async () => {
    mocks.updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.stateMaybeSingle.mockResolvedValueOnce({ data: pristineRegistrationState, error: null })
      .mockResolvedValueOnce({ data: { ...pristineRegistrationState, shared_registration_id: "registration" }, error: null });
    const response = await POST(makeRequest(fullRequest));
    expect(mocks.updateIs).toHaveBeenCalledWith("shared_registration_id", null);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: SETTINGS_REGISTRATION_LOCK_CODE, error: BUSINESS_ADDRESS_LOCK_COPY.message });
  });

  it("lets failed registration unlock a full update despite provider state", async () => {
    mocks.stateMaybeSingle.mockResolvedValue({
      data: {
        telnyx_brand_id: "brand-1",
        brand_status: "approved",
        campaign_status: "approved",
        onboarding_registration_status: "failed",
      },
      error: null,
    });

    const response = await POST(makeRequest(fullRequest));

    expect(response.status).toBe(200);
    expect(mocks.businessUpdate).toHaveBeenCalledOnce();
    expect(mocks.updateEq).toHaveBeenCalledWith(
      "onboarding_registration_status",
      "failed"
    );
  });

  it.each([
    ["brand", { brand_status: "rejected" }],
    ["campaign", { campaign_status: "rejected" }],
  ])(
    "keeps a failed %s rejection locked for a full address update",
    async (_label, rejection) => {
      mocks.stateMaybeSingle.mockResolvedValue({
        data: {
          ...pristineRegistrationState,
          ...rejection,
          telnyx_brand_id: "brand-1",
          onboarding_registration_status: "failed",
        },
        error: null,
      });

      const response = await POST(makeRequest(fullRequest));

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        code: SETTINGS_REGISTRATION_LOCK_CODE,
        error: BUSINESS_ADDRESS_LOCK_COPY.message,
      });
      expect(mocks.businessUpdate).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["a read error", { data: null, error: new Error("read failed") }],
    ["a missing row", { data: null, error: null }],
  ])("fails closed when fresh registration state has %s", async (_name, result) => {
    mocks.stateMaybeSingle.mockResolvedValue(result);

    const response = await POST(makeRequest(fullRequest));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: REGISTRATION_STATE_UNAVAILABLE_CODE,
      error: REGISTRATION_STATE_UNAVAILABLE_MESSAGE,
    });
    expect(mocks.businessUpdate).not.toHaveBeenCalled();
  });

  it("returns a stable save failure when the guarded update errors", async () => {
    mocks.updateMaybeSingle.mockResolvedValue({
      data: null,
      error: new Error("update failed"),
    });

    const response = await POST(makeRequest(fullRequest));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to save business information",
    });
  });

  it("returns the address lock response when registration starts during a full save", async () => {
    mocks.updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.stateMaybeSingle
      .mockResolvedValueOnce({ data: pristineRegistrationState, error: null })
      .mockResolvedValueOnce({
        data: {
          ...pristineRegistrationState,
          campaign_status: "pending",
          onboarding_registration_status: "submitted",
        },
        error: null,
      });

    const response = await POST(makeRequest(fullRequest));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: SETTINGS_REGISTRATION_LOCK_CODE,
      error: BUSINESS_ADDRESS_LOCK_COPY.message,
    });
    expect(mocks.stateMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("returns the address lock when the guarded save loses to a failed rejection", async () => {
    mocks.updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.stateMaybeSingle
      .mockResolvedValueOnce({ data: pristineRegistrationState, error: null })
      .mockResolvedValueOnce({
        data: {
          ...pristineRegistrationState,
          telnyx_brand_id: "brand-1",
          campaign_status: "rejected",
          onboarding_registration_status: "failed",
        },
        error: null,
      });

    const response = await POST(makeRequest(fullRequest));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: SETTINGS_REGISTRATION_LOCK_CODE,
      error: BUSINESS_ADDRESS_LOCK_COPY.message,
    });
    expect(mocks.stateMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("returns 409 when the guarded registration snapshot changes but stays unlocked", async () => {
    mocks.updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.stateMaybeSingle
      .mockResolvedValueOnce({ data: pristineRegistrationState, error: null })
      .mockResolvedValueOnce({
        data: {
          ...pristineRegistrationState,
          onboarding_registration_status: "submitting",
        },
        error: null,
      });

    const response = await POST(makeRequest(fullRequest));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: SETTINGS_STATE_CHANGED_CODE,
      error: SETTINGS_STATE_CHANGED_MESSAGE,
    });
    expect(mocks.stateMaybeSingle).toHaveBeenCalledTimes(2);
  });

  it("fails closed when state cannot be reloaded after a snapshot miss", async () => {
    mocks.updateMaybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.stateMaybeSingle
      .mockResolvedValueOnce({ data: pristineRegistrationState, error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("reload failed") });

    const response = await POST(makeRequest(fullRequest));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: REGISTRATION_STATE_UNAVAILABLE_CODE,
      error: REGISTRATION_STATE_UNAVAILABLE_MESSAGE,
    });
  });
});
