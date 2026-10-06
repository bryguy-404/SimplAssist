import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: { messaging10dlc: { campaign: { list: mocks.list } } },
}));

import { readReviewCampaignInventory } from "./campaignInventory.server";

const brandId = "4b200000-0000-4000-a100-000000000001";
const record = (id: string, referenceId = "original-reference") => ({ campaignId: id, brandId, referenceId });
const incomplete = { code: "review_sms_campaign_inventory_incomplete", status: 503 };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("bounded campaign inventory", () => {
  it("finishes the live two-record response without the SDK's unnecessary extra page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T03:50:08.000Z"));
    const records = [record("campaign-one"), record("campaign-two", "second-reference")];
    mocks.list.mockResolvedValue({ page: 1, totalRecords: 2, records });

    await expect(readReviewCampaignInventory(brandId)).resolves.toEqual({ records, observedAt: "2026-10-06T03:50:08.000Z" });
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(
      { brandId, page: 1, recordsPerPage: 100 }, { maxRetries: 0, timeout: 5000 },
    );
  });

  it("collects consecutive pages to the declared total and permits campaigns without references", async () => {
    const first = { campaignId: "campaign-one", brandId };
    const second = record("campaign-two", "reviews:account:r1");
    mocks.list.mockResolvedValueOnce({ page: 1, totalRecords: 2, records: [first] })
      .mockResolvedValueOnce({ page: 2, totalRecords: 2, records: [second] });

    expect((await readReviewCampaignInventory(brandId)).records).toEqual([first, second]);
    expect(mocks.list).toHaveBeenNthCalledWith(2,
      { brandId, page: 2, recordsPerPage: 100 }, { maxRetries: 0, timeout: 5000 },
    );
  });

  it("accepts an explicitly empty, complete inventory", async () => {
    mocks.list.mockResolvedValue({ page: 1, totalRecords: 0, records: [] });
    expect((await readReviewCampaignInventory(brandId)).records).toEqual([]);
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it.each([
    { page: 2, totalRecords: 1, records: [record("one")] },
    { page: 1, totalRecords: "1", records: [record("one")] },
    { page: 1, totalRecords: -1, records: [] },
    { page: 1, totalRecords: 1.5, records: [record("one")] },
    { page: 1, totalRecords: 1, records: null },
    { page: 1, totalRecords: 1, records: [] },
    { page: 1, totalRecords: 0, records: [record("one")] },
    { page: 1, totalRecords: 1, records: [{ ...record("one"), brandId: "other-brand" }] },
    { page: 1, totalRecords: 2, records: [record("one"), record("one")] },
  ])("rejects incomplete or inconsistent first-page evidence %#", async (page) => {
    mocks.list.mockResolvedValue(page);
    await expect(readReviewCampaignInventory(brandId)).rejects.toMatchObject(incomplete);
    expect(mocks.list).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { brandId, campaignId: 123 },
    { brandId, campaignId: " " },
    { brandId, campaignId: " campaign-one" },
    { brandId, campaignId: "x".repeat(129) },
    { brandId, campaignId: "one", referenceId: { value: "reviews:account:r1" } },
  ])("rejects malformed records before declaring a reference absent %#", async (item) => {
    mocks.list.mockResolvedValue({ page: 1, totalRecords: 1, records: [item] });
    await expect(readReviewCampaignInventory(brandId)).rejects.toMatchObject(incomplete);
  });

  it.each([
    { page: 2, totalRecords: 3, records: [record("two")] },
    { page: 2, totalRecords: 2, records: [record("one")] },
    { page: 2, totalRecords: 2, records: [] },
  ])("rejects totals changing, duplicates or empty pages during pagination %#", async (secondPage) => {
    mocks.list.mockResolvedValueOnce({ page: 1, totalRecords: 2, records: [record("one")] })
      .mockResolvedValueOnce(secondPage);
    await expect(readReviewCampaignInventory(brandId)).rejects.toMatchObject(incomplete);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("stops after five incomplete pages rather than hanging or treating partial data as complete", async () => {
    mocks.list.mockImplementation(async ({ page }: { page: number }) => ({ page, totalRecords: 6, records: [record(`campaign-${page}`)] }));
    await expect(readReviewCampaignInventory(brandId)).rejects.toMatchObject(incomplete);
    expect(mocks.list).toHaveBeenCalledTimes(5);
  });

  it("propagates provider read failure without retrying or declaring an empty inventory", async () => {
    const error = new Error("provider unavailable");
    mocks.list.mockRejectedValue(error);
    await expect(readReviewCampaignInventory(brandId)).rejects.toBe(error);
    expect(mocks.list).toHaveBeenCalledOnce();
  });
});
