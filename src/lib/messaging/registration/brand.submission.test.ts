import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendRegistrationEvent: vi.fn(),
  createBrand: vi.fn(),
  from: vi.fn(), sharedContext: vi.fn(), sharedValidate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/sharedBusinessRegistrations.server", () => ({
  readSharedRegistrationContext: mocks.sharedContext, validateSharedRegistrationProof: mocks.sharedValidate,
}));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
    messaging10dlc: {
      brand: {
        create: mocks.createBrand,
      },
    },
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: mocks.from,
  },
}));
vi.mock("./audit", () => ({
  appendRegistrationEvent: mocks.appendRegistrationEvent,
  serializeError: vi.fn(),
}));
vi.mock("./campaign", () => ({
  archiveAndClearRejectedCampaign: vi.fn(),
}));

import { registerBrand } from "./brand";
import { CarrierRejectionSupportRequiredError } from "@/lib/onboarding/rejectionGuidance";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const BRAND_ID = "4b20019d-e93e-4000-8000-000000000001";
const BUSINESS = {
  id: BUSINESS_ID,
  owner_id: "owner",
  shared_registration_id: null as string | null,
  name: "Example Dental",
  slug: "example-dental",
  legal_business_name: "Example Dental LLC",
  business_entity_type: "llc",
  business_type: "dentist",
  has_ein: true,
  ein: "12-3456789",
  compliance_info_completed_at: "2026-08-05T12:00:00.000Z",
  telnyx_brand_id: null as string | null,
  authorized_rep_name: "Avery Dentist",
  authorized_rep_email: "avery@example.com",
  authorized_rep_phone: "317-555-0100",
  address: "100 Main Street",
  city: "Indianapolis",
  state: "IN",
  zip: "46204",
  website_url: "https://example.com",
  brand_status: null as string | null,
  campaign_status: null as string | null,
  brand_rejection_reason: null as string | null,
  campaign_rejection_reason: null as string | null,
};

let businessSnapshot: typeof BUSINESS;
let carrierSnapshot: {
  brand_status: string | null;
  campaign_status: string | null;
  brand_rejection_reason: string | null;
  campaign_rejection_reason: string | null;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sharedContext.mockResolvedValue(null); mocks.sharedValidate.mockResolvedValue(null);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");

  carrierSnapshot = {
    brand_status: null,
    campaign_status: null,
    brand_rejection_reason: null,
    campaign_rejection_reason: null,
  };
  businessSnapshot = { ...BUSINESS };

  mocks.from.mockReturnValue({
    select: vi.fn((columns: string) => ({
      eq: vi.fn(() => ({
        single: vi.fn(async () => ({
          data: columns.startsWith("brand_status")
            ? carrierSnapshot
            : businessSnapshot,
          error: null,
        })),
      })),
    })),
    update: vi.fn(() => ({
      eq: vi.fn(async () => ({ error: null })),
    })),
  });
  mocks.createBrand.mockResolvedValue({ brandId: BRAND_ID });
  mocks.appendRegistrationEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("registerBrand charged provider submission", () => {
  it.each([
    ["brand", "Existing brand was rejected"],
    ["campaign", "Existing campaign was rejected"],
  ] as const)(
    "does not reuse an existing brand id after a %s rejection",
    async (resource, reason) => {
      businessSnapshot = {
        ...BUSINESS,
        telnyx_brand_id: BRAND_ID,
        brand_status: resource === "brand" ? "rejected" : "approved",
        campaign_status: resource === "campaign" ? "rejected" : null,
        brand_rejection_reason: resource === "brand" ? reason : null,
        campaign_rejection_reason: resource === "campaign" ? reason : null,
      };

      const error = await registerBrand(BUSINESS_ID).catch((caught) => caught);

      expect(error).toBeInstanceOf(CarrierRejectionSupportRequiredError);
      expect(error).toMatchObject({
        code: "rejection_support_required",
        carrierReason: reason,
        rejectedResource: resource,
      });
      expect(mocks.createBrand).not.toHaveBeenCalled();
      expect(mocks.appendRegistrationEvent).not.toHaveBeenCalled();
    },
  );

  it("disables SDK retries and invokes brand creation exactly once", async () => {
    await registerBrand(BUSINESS_ID);

    expect(mocks.createBrand).toHaveBeenCalledOnce();
    expect(mocks.createBrand).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Example Dental",
        ein: "123456789",
        website: "https://example.com",
      }),
      { maxRetries: 0 },
    );
  });

  it("does not replay a rejected create from the catch path", async () => {
    const providerError = new Error("provider timeout");
    mocks.createBrand.mockRejectedValue(providerError);

    await expect(registerBrand(BUSINESS_ID)).rejects.toBe(providerError);

    expect(mocks.createBrand).toHaveBeenCalledOnce();
    expect(mocks.createBrand).toHaveBeenCalledWith(
      expect.any(Object),
      { maxRetries: 0 },
    );
  });

  it.each([
    [
      "brand",
      {
        brand_status: "rejected",
        campaign_status: null,
        brand_rejection_reason: "Exact brand carrier reason",
        campaign_rejection_reason: null,
      },
    ],
    [
      "campaign",
      {
        brand_status: "approved",
        campaign_status: "rejected",
        brand_rejection_reason: null,
        campaign_rejection_reason: "Exact campaign carrier reason",
      },
    ],
  ])(
    "fails closed when a %s rejection lands immediately before charged brand creation",
    async (_label, snapshot) => {
      carrierSnapshot = snapshot;

      const error = await registerBrand(BUSINESS_ID).catch((caught) => caught);

      expect(error).toBeInstanceOf(CarrierRejectionSupportRequiredError);
      expect(error).toMatchObject({
        code: "rejection_support_required",
        carrierReason:
          snapshot.brand_rejection_reason ?? snapshot.campaign_rejection_reason,
      });
      expect(mocks.createBrand).not.toHaveBeenCalled();
    },
  );
});

describe("registerBrand shared registration reuse", () => {
  it("never creates a replacement when shared staging has no bound provider ID", async () => {
    businessSnapshot.shared_registration_id = "shared-registration";
    mocks.sharedContext.mockResolvedValue({ registration: { id: "shared-registration", brand_id: BRAND_ID } });
    const paid = vi.fn();
    await expect(registerBrand(BUSINESS_ID, { beforePaidSubmit: paid })).rejects.toMatchObject({ code: "linked_brand_needs_support" });
    expect(paid).not.toHaveBeenCalled(); expect(mocks.createBrand).not.toHaveBeenCalled();
  });
  it("reuses only an actively bound canonical brand and does not record a paid create", async () => {
    businessSnapshot.shared_registration_id = "shared-registration"; businessSnapshot.telnyx_brand_id = BRAND_ID;
    mocks.sharedContext.mockResolvedValue({ registration: { id: "shared-registration", brand_id: BRAND_ID, identity_version: 1 }, membership: { revision: 2 } });
    const paid = vi.fn(); await registerBrand(BUSINESS_ID, { beforePaidSubmit: paid });
    expect(mocks.sharedValidate).toHaveBeenCalledWith({ businessId: BUSINESS_ID, ownerId: "owner", requireActive: true,
      proof: { registrationId: "shared-registration", identityVersion: 1, membershipRevision: 2, brandId: BRAND_ID } });
    expect(paid).not.toHaveBeenCalled(); expect(mocks.createBrand).not.toHaveBeenCalled();
  });
  it("does not fall back to creating a brand when shared proof validation fails", async () => {
    businessSnapshot.shared_registration_id = "shared-registration"; businessSnapshot.telnyx_brand_id = BRAND_ID;
    mocks.sharedContext.mockResolvedValue({ registration: { id: "shared-registration", brand_id: BRAND_ID, identity_version: 1 }, membership: { revision: 2 } });
    mocks.sharedValidate.mockRejectedValue(new Error("revoked"));
    await expect(registerBrand(BUSINESS_ID)).rejects.toThrow("revoked"); expect(mocks.createBrand).not.toHaveBeenCalled();
  });
});
