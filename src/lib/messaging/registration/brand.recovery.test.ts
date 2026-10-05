import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  deleteBrand: vi.fn(),
  archiveCampaign: vi.fn(),
  appendRegistrationEvent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
    messaging10dlc: {
      brand: {
        create: vi.fn(),
        delete: mocks.deleteBrand,
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
  archiveAndClearRejectedCampaign: mocks.archiveCampaign,
}));

import {
  archiveAndClearRejectedBrand,
  LINKED_EXISTING_BRAND_NEEDS_SUPPORT_CODE,
  LINKED_EXISTING_BRAND_NEEDS_SUPPORT_MESSAGE,
  LinkedExistingBrandSupportRequiredError,
} from "./brand";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const BRAND_ID = "4b20019d-e93e-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();

  const query = {
    select: mocks.select,
    eq: mocks.eq,
    single: mocks.single,
    insert: mocks.insert,
    update: mocks.update,
  };
  mocks.from.mockReturnValue(query);
  mocks.select.mockReturnValue(query);
  mocks.eq.mockReturnValue(query);
  mocks.insert.mockReturnValue(query);
  mocks.update.mockReturnValue(query);
  mocks.single.mockResolvedValue({
    data: {
      id: BUSINESS_ID,
      telnyx_brand_id: BRAND_ID,
      telnyx_brand_source: "linked_existing",
      brand_status: "rejected",
      brand_rejection_reason: "Carrier rejection",
    },
    error: null,
  });
});

describe("archiveAndClearRejectedBrand linked-brand protection", () => {
  it("throws the stable support-required domain error for a rejected linked brand", async () => {
    let error: unknown;
    try {
      await archiveAndClearRejectedBrand(BUSINESS_ID);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(LinkedExistingBrandSupportRequiredError);
    expect(error).toMatchObject({
      name: "LinkedExistingBrandSupportRequiredError",
      code: LINKED_EXISTING_BRAND_NEEDS_SUPPORT_CODE,
      message: LINKED_EXISTING_BRAND_NEEDS_SUPPORT_MESSAGE,
      retryable: false,
      businessId: BUSINESS_ID,
    });
  });

  it("performs only the identifying read and no provider or database mutation", async () => {
    await expect(
      archiveAndClearRejectedBrand(BUSINESS_ID)
    ).rejects.toBeInstanceOf(LinkedExistingBrandSupportRequiredError);

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("businesses");
    expect(mocks.select).toHaveBeenCalledWith(
      "id, telnyx_brand_id, telnyx_brand_source, shared_registration_id, brand_status, brand_rejection_reason"
    );
    expect(mocks.eq).toHaveBeenCalledWith("id", BUSINESS_ID);
    expect(mocks.single).toHaveBeenCalledTimes(1);

    expect(mocks.from).not.toHaveBeenCalledWith("rejected_brands");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.archiveCampaign).not.toHaveBeenCalled();
    expect(mocks.deleteBrand).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).not.toHaveBeenCalled();
  });
});

describe("shared brand rejected recovery", () => {
  it("never archives, clears or deletes a canonical shared brand even when its original source was created here", async () => {
    mocks.single.mockResolvedValue({ data: { id: BUSINESS_ID, telnyx_brand_id: BRAND_ID, telnyx_brand_source: "created_by_simplassist", shared_registration_id: "shared-registration", brand_status: "rejected" }, error: null });
    await expect(archiveAndClearRejectedBrand(BUSINESS_ID)).rejects.toBeInstanceOf(LinkedExistingBrandSupportRequiredError);
    expect(mocks.from).toHaveBeenCalledTimes(1); expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.archiveCampaign).not.toHaveBeenCalled(); expect(mocks.deleteBrand).not.toHaveBeenCalled();
  });
});
