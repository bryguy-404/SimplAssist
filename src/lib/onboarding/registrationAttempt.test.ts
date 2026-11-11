import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { claimRegistrationAttempt, markRegistrationSubmitted } from "./registrationAttempt";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000123";
const STARTED_AT = "2026-08-28T12:00:00.000Z";

const chains: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

function queueResults(...results: unknown[]) {
  const queue = [...results];
  chains.length = 0;
  mocks.from.mockImplementation(() => {
    const result = queue.shift() ?? { data: null, error: null };
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of [
      "select",
      "update",
      "eq",
      "is",
      "maybeSingle",
      "returns",
    ]) {
      chain[method] = vi.fn(() => chain);
    }
    const promise = Promise.resolve(result);
    Object.assign(chain, {
      then: promise.then.bind(promise),
      catch: promise.catch.bind(promise),
    });
    chains.push(chain);
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claim pending brand continuation", () => {
  const pending = { id: BUSINESS_ID, onboarding_registration_status: "submitted",
    onboarding_registration_started_at: STARTED_AT, onboarding_registration_submitted_at: STARTED_AT,
    onboarding_registration_error: null, telnyx_brand_id: "brand", telnyx_campaign_id: null, brand_status: "approved" };
  it("claims an approved unfinished campaign with resource and approval guards", async () => {
    queueResults({ data: pending, error: null }, { data: [{ ...pending, onboarding_registration_status: "submitting" }], error: null });
    expect(await claimRegistrationAttempt(BUSINESS_ID)).toMatchObject({ claimed: true, claimedFrom: "pending_brand" });
    expect(chains[1].eq).toHaveBeenCalledWith("onboarding_registration_status", "submitted");
    expect(chains[1].eq).toHaveBeenCalledWith("telnyx_brand_id", "brand");
    expect(chains[1].eq).toHaveBeenCalledWith("brand_status", "approved");
    expect(chains[1].is).toHaveBeenCalledWith("telnyx_campaign_id", null);
  });
  it.each([{ brand_status: "pending" }, { brand_status: "rejected" }, { telnyx_campaign_id: "campaign" },
    { onboarding_registration_error: "A real failure" }, { telnyx_brand_id: null }])(
    "does not claim an ineligible or completed submitted row: %j", async (change) => {
      queueResults({ data: { ...pending, ...change }, error: null });
      expect(await claimRegistrationAttempt(BUSINESS_ID)).toMatchObject({ claimed: false });
      expect(chains).toHaveLength(1);
    });
  it("does not acquire a second claim when another continuation wins", async () => {
    const submitting = { ...pending, onboarding_registration_status: "submitting" };
    queueResults({ data: pending, error: null }, { data: [], error: null }, { data: submitting, error: null });
    expect(await claimRegistrationAttempt(BUSINESS_ID)).toMatchObject({ claimed: false, reason: "already_submitting" });
  });
});

describe("markRegistrationSubmitted", () => {
  it("completes only the exact submitting claim", async () => {
    queueResults({
      data: {
        id: BUSINESS_ID,
        onboarding_registration_status: "submitted",
        onboarding_registration_started_at: STARTED_AT,
        onboarding_registration_submitted_at: "2026-08-28T12:01:00.000Z",
        onboarding_registration_error: null,
      },
      error: null,
    });

    await expect(
      markRegistrationSubmitted(BUSINESS_ID, STARTED_AT),
    ).resolves.toEqual({ completed: true });

    expect(chains).toHaveLength(1);
    expect(chains[0].eq).toHaveBeenCalledWith("id", BUSINESS_ID);
    expect(chains[0].eq).toHaveBeenCalledWith(
      "onboarding_registration_status",
      "submitting",
    );
    expect(chains[0].eq).toHaveBeenCalledWith(
      "onboarding_registration_started_at",
      STARTED_AT,
    );
  });

  it("returns the current row when a rejection wins the completion CAS", async () => {
    const rejectionRow = {
      id: BUSINESS_ID,
      onboarding_registration_status: "failed",
      onboarding_registration_started_at: STARTED_AT,
      onboarding_registration_submitted_at: null,
      onboarding_registration_error: "Exact carrier rejection reason",
    };
    queueResults(
      { data: null, error: null },
      { data: rejectionRow, error: null },
    );

    await expect(
      markRegistrationSubmitted(BUSINESS_ID, STARTED_AT),
    ).resolves.toEqual({ completed: false, current: rejectionRow });

    expect(chains).toHaveLength(2);
    expect(chains[1].select).toHaveBeenCalledWith(
      expect.stringContaining("onboarding_registration_error"),
    );
    expect(chains[1].eq).toHaveBeenCalledWith("id", BUSINESS_ID);
  });

  it("fails closed when the exact completion update errors", async () => {
    queueResults({ data: null, error: { message: "database unavailable" } });

    await expect(
      markRegistrationSubmitted(BUSINESS_ID, STARTED_AT),
    ).rejects.toThrow("Failed to mark registration submitted");

    expect(mocks.from).toHaveBeenCalledTimes(1);
  });
});
