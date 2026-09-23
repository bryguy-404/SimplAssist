import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  canContinueTextingUpgradeProvisioning: vi.fn(),
  assertTextingUpgradeProvisioningAllowed: vi.fn(),
  reconcileTextingUpgradeActivationForBusiness: vi.fn(),
  retrieveAssignment: vi.fn(),
  retrieveTaskStatus: vi.fn(),
  createAssignment: vi.fn(),
  bulkAssignProfile: vi.fn(),
  appendRegistrationEvent: vi.fn(),
  serializeError: vi.fn(),
}));

vi.mock("@/lib/billing/textingUpgradeActivation.server", () => ({
  canContinueTextingUpgradeProvisioning: mocks.canContinueTextingUpgradeProvisioning,
  assertTextingUpgradeProvisioningAllowed: mocks.assertTextingUpgradeProvisioningAllowed,
  reconcileTextingUpgradeActivationForBusiness: mocks.reconcileTextingUpgradeActivationForBusiness,
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: mocks.from,
  },
}));

vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
    messaging10dlc: {
      phoneNumberCampaigns: {
        retrieve: mocks.retrieveAssignment,
        create: mocks.createAssignment,
      },
      phoneNumberAssignmentByProfile: {
        retrieveStatus: mocks.retrieveTaskStatus,
        assign: mocks.bulkAssignProfile,
      },
    },
  },
}));

vi.mock("./audit", () => ({
  appendRegistrationEvent: mocks.appendRegistrationEvent,
  serializeError: mocks.serializeError,
}));

import { ensureCampaignAssignmentForBusiness } from "./phoneNumberAssignment";

const NOW = "2026-07-28T10:30:00.000Z";
const BUSINESS_ID = "ea848911-ef72-44a6-8cf3-c47b3959be26";
const BRAND_ID = "c40e92ad-5ebd-4f62-b46c-94af592ea647";
const CAMPAIGN_ID = "4b30019f-8814-cb6c-1e77-950fa70e0410";
const OLD_CAMPAIGN_ID = "a7c2410b-49a7-4cc7-a2f4-b1ee1517c81c";
const PROFILE_ID = "40019f88-14ce-429f-a024-17fd89a4fe92";
const PHONE_ID = "b2d24476-f524-4656-b8f9-16802f78149e";
const PHONE_NUMBER = "+15742638634";
const SECOND_PHONE_ID = "f675c365-f1c4-4f7e-93cc-da54ca2e1ccd";
const SECOND_PHONE_NUMBER = "+15742638635";

type QueryOperation = "select" | "update";
type QueryFilter = {
  kind: "eq" | "is";
  column: string;
  value: unknown;
};
type QueryRecord = {
  table: string;
  operation: QueryOperation;
  selection: string | null;
  payload: Record<string, unknown> | null;
  filters: QueryFilter[];
  orExpressions: string[];
};
type QueryResult = {
  data?: unknown;
  error: { message: string } | null;
};

type BusinessState = {
  id: string;
  updated_at: string;
  deleted_at: string | null;
  operations_suspended_at: string | null;
  telnyx_unique_claims_released_at: string | null;
  active_telnyx_release_run_id: string | null;
  telnyx_resource_state: string;
  telnyx_submission_disabled: boolean;
  telnyx_brand_id: string | null;
  telnyx_campaign_id: string | null;
  telnyx_messaging_profile_id: string | null;
  brand_status: string | null;
  campaign_status: string | null;
  telnyx_campaign_assignment_claim_token: string | null;
  telnyx_campaign_assignment_claimed_at: string | null;
  telnyx_campaign_assignment_claim_campaign_id: string | null;
  telnyx_campaign_assignment_claim_profile_id: string | null;
};

type PhoneState = {
  id: string;
  business_id: string;
  phone_number: string;
  is_active: boolean;
  resource_status: string;
  telnyx_campaign_assignment_status:
    | "unassigned"
    | "pending"
    | "assigned"
    | "failed";
  telnyx_campaign_assignment_task_id: string | null;
  telnyx_campaign_assignment_campaign_id: string | null;
  telnyx_campaign_assignment_failure_reason: string | null;
  telnyx_campaign_assignment_updated_at: string | null;
  telnyx_campaign_assigned_at: string | null;
};

let business: BusinessState;
let phoneRows: PhoneState[];
let queryLog: QueryRecord[];
let timeline: string[];
let businessRenewalCount: number;
let businessRenewalMissOnCall: number | null;
let businessUpdatedAtDriftOnPhoneRead: boolean;
let claimedPhoneIds: Set<string>;
let phoneClaimMissIds: Set<string>;
let phoneFinalizationMissIds: Set<string>;

function safeBusiness(overrides: Partial<BusinessState> = {}): BusinessState {
  return {
    id: BUSINESS_ID,
    updated_at: "2026-07-28T10:00:00.000Z",
    deleted_at: null,
    operations_suspended_at: null,
    telnyx_unique_claims_released_at: null,
    active_telnyx_release_run_id: null,
    telnyx_resource_state: "active",
    telnyx_submission_disabled: false,
    telnyx_brand_id: BRAND_ID,
    telnyx_campaign_id: CAMPAIGN_ID,
    telnyx_messaging_profile_id: PROFILE_ID,
    brand_status: "approved",
    campaign_status: "approved",
    telnyx_campaign_assignment_claim_token: null,
    telnyx_campaign_assignment_claimed_at: null,
    telnyx_campaign_assignment_claim_campaign_id: null,
    telnyx_campaign_assignment_claim_profile_id: null,
    ...overrides,
  };
}

function unassignedPhone(overrides: Partial<PhoneState> = {}): PhoneState {
  return {
    id: PHONE_ID,
    business_id: BUSINESS_ID,
    phone_number: PHONE_NUMBER,
    is_active: true,
    resource_status: "active",
    telnyx_campaign_assignment_status: "unassigned",
    telnyx_campaign_assignment_task_id: null,
    telnyx_campaign_assignment_campaign_id: null,
    telnyx_campaign_assignment_failure_reason: null,
    telnyx_campaign_assignment_updated_at: null,
    telnyx_campaign_assigned_at: null,
    ...overrides,
  };
}

function matchesFilters(
  row: Record<string, unknown>,
  filters: QueryFilter[]
): boolean {
  return filters.every((filter) => {
    const actual = row[filter.column];
    return filter.kind === "is"
      ? filter.value === null
        ? actual === null
        : actual === filter.value
      : actual === filter.value;
  });
}

function matchesOrExpressions(
  row: Record<string, unknown>,
  expressions: string[]
): boolean {
  return expressions.every((expression) => {
    const staleClaimPrefix =
      "telnyx_campaign_assignment_claim_token.is.null," +
      "telnyx_campaign_assignment_claimed_at.lt.";
    if (!expression.startsWith(staleClaimPrefix)) {
      throw new Error(`Unexpected or expression: ${expression}`);
    }

    const staleBefore = expression.slice(staleClaimPrefix.length);
    const claimedAt = row.telnyx_campaign_assignment_claimed_at;
    return (
      row.telnyx_campaign_assignment_claim_token === null ||
      (typeof claimedAt === "string" && claimedAt < staleBefore)
    );
  });
}

function executeBusinessesQuery(query: QueryRecord): QueryResult {
  if (query.operation === "update") {
    const matches =
      matchesFilters(
        business as unknown as Record<string, unknown>,
        query.filters
      ) &&
      matchesOrExpressions(
        business as unknown as Record<string, unknown>,
        query.orExpressions
      );
    const isClaim =
      typeof query.payload?.telnyx_campaign_assignment_claim_token ===
      "string";
    const isRelease =
      query.payload?.telnyx_campaign_assignment_claim_token === null;
    const isRenewal = !isClaim && !isRelease;

    if (isRenewal) {
      businessRenewalCount += 1;
    }
    timeline.push(
      isClaim
        ? "business_claim"
        : isRelease
          ? "business_claim_release"
          : "business_renew"
    );
    if (
      !matches ||
      (isRenewal && businessRenewalMissOnCall === businessRenewalCount)
    ) {
      return { data: null, error: null };
    }

    Object.assign(business, query.payload, { updated_at: NOW });
    return {
      data: query.selection ? { ...business } : undefined,
      error: null,
    };
  }

  timeline.push("business_read");
  const matches = matchesFilters(
    business as unknown as Record<string, unknown>,
    query.filters
  );
  return { data: matches ? { ...business } : null, error: null };
}

function executePhoneNumbersQuery(query: QueryRecord): QueryResult {
  if (query.operation === "select") {
    timeline.push("phone_read");
    if (businessUpdatedAtDriftOnPhoneRead) {
      business.updated_at = "2026-07-28T10:30:01.000Z";
    }
    return {
      data: phoneRows
        .filter((row) =>
          matchesFilters(
            row as unknown as Record<string, unknown>,
            query.filters
          )
        )
        .map((row) => ({ ...row })),
      error: null,
    };
  }

  const matchingRows = phoneRows.filter((row) =>
    matchesFilters(row as unknown as Record<string, unknown>, query.filters)
  );
  const targetId = query.filters.find((filter) => filter.column === "id")
    ?.value;
  const isSelectedUpdate = query.selection === "id";
  const isIntentClaim =
    isSelectedUpdate &&
    typeof targetId === "string" &&
    !claimedPhoneIds.has(targetId);
  const isFinalization =
    isSelectedUpdate &&
    typeof targetId === "string" &&
    claimedPhoneIds.has(targetId);
  const isIntentRelease = !isSelectedUpdate;

  if (isIntentClaim) {
    timeline.push("phone_intent_claim");
    if (
      typeof targetId === "string" &&
      phoneClaimMissIds.has(targetId)
    ) {
      return { data: null, error: null };
    }
  } else if (isFinalization) {
    timeline.push("phone_intent_finalize");
    if (
      typeof targetId === "string" &&
      phoneFinalizationMissIds.has(targetId)
    ) {
      return { data: null, error: null };
    }
  } else if (isIntentRelease) {
    timeline.push("phone_intent_release");
  } else {
    timeline.push("phone_update");
  }

  for (const row of matchingRows) {
    Object.assign(row, query.payload);
  }
  if (typeof targetId === "string" && matchingRows.length > 0) {
    if (isIntentClaim) {
      claimedPhoneIds.add(targetId);
    } else if (isFinalization || isIntentRelease) {
      claimedPhoneIds.delete(targetId);
    }
  }

  return {
    data:
      isSelectedUpdate && matchingRows[0]
        ? { id: matchingRows[0].id }
        : undefined,
    error: null,
  };
}

function executeQuery(query: QueryRecord): QueryResult {
  queryLog.push({
    ...query,
    payload: query.payload ? { ...query.payload } : null,
    filters: query.filters.map((filter) => ({ ...filter })),
    orExpressions: [...query.orExpressions],
  });

  if (query.table === "businesses") {
    return executeBusinessesQuery(query);
  }
  if (query.table === "phone_numbers") {
    return executePhoneNumbersQuery(query);
  }
  throw new Error(`Unexpected table ${query.table}`);
}

function createQuery(table: string) {
  let operation: QueryOperation = "select";
  let selection: string | null = null;
  let payload: Record<string, unknown> | null = null;
  const filters: QueryFilter[] = [];
  const orExpressions: string[] = [];
  let resultPromise: Promise<QueryResult> | null = null;

  const execute = () => {
    if (!resultPromise) {
      resultPromise = Promise.resolve(
        executeQuery({
          table,
          operation,
          selection,
          payload,
          filters,
          orExpressions,
        })
      );
    }
    return resultPromise;
  };

  const chain: Record<string, unknown> = {};
  chain.select = vi.fn((columns: string) => {
    selection = columns;
    return chain;
  });
  chain.update = vi.fn((values: Record<string, unknown>) => {
    operation = "update";
    payload = values;
    return chain;
  });
  chain.eq = vi.fn((column: string, value: unknown) => {
    filters.push({ kind: "eq", column, value });
    return chain;
  });
  chain.is = vi.fn((column: string, value: unknown) => {
    filters.push({ kind: "is", column, value });
    return chain;
  });
  chain.or = vi.fn((expression: string) => {
    orExpressions.push(expression);
    return chain;
  });
  chain.single = vi.fn(execute);
  chain.maybeSingle = vi.fn(execute);
  chain.returns = vi.fn(() => chain);
  chain.then = (
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => execute().then(onFulfilled, onRejected);

  return chain;
}

function phoneQueries(): QueryRecord[] {
  return queryLog.filter((query) => query.table === "phone_numbers");
}

function businessQueries(): QueryRecord[] {
  return queryLog.filter((query) => query.table === "businesses");
}

function intentClaimQuery(): QueryRecord {
  const claim = phoneQueries().find(
    (query) =>
      query.operation === "update" &&
      query.selection === "id"
  );
  if (!claim) throw new Error("Expected an intent claim query");
  return claim;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  mocks.canContinueTextingUpgradeProvisioning.mockResolvedValue(true);
  mocks.assertTextingUpgradeProvisioningAllowed.mockResolvedValue(undefined);
  mocks.reconcileTextingUpgradeActivationForBusiness.mockResolvedValue(false);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  business = safeBusiness();
  phoneRows = [unassignedPhone()];
  queryLog = [];
  timeline = [];
  businessRenewalCount = 0;
  businessRenewalMissOnCall = null;
  businessUpdatedAtDriftOnPhoneRead = false;
  claimedPhoneIds = new Set();
  phoneClaimMissIds = new Set();
  phoneFinalizationMissIds = new Set();

  mocks.from.mockImplementation((table: string) => createQuery(table));
  mocks.retrieveAssignment.mockImplementation(async () => {
    timeline.push("provider_inspect");
    throw { status: 404 };
  });
  mocks.retrieveTaskStatus.mockResolvedValue({ status: "pending" });
  mocks.createAssignment.mockImplementation(async () => {
    timeline.push("provider_create");
    return {
      phoneNumber: PHONE_NUMBER,
      campaignId: CAMPAIGN_ID,
      assignmentStatus: "PENDING_ASSIGNMENT",
    };
  });
  mocks.appendRegistrationEvent.mockResolvedValue(undefined);
  mocks.serializeError.mockImplementation((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureCampaignAssignmentForBusiness safety gates", () => {
  it("does not claim numbers or contact Telnyx after upgrade cancellation", async () => {
    mocks.canContinueTextingUpgradeProvisioning.mockResolvedValue(false);
    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });
    expect(phoneQueries()).toHaveLength(0);
    expect(mocks.retrieveAssignment).not.toHaveBeenCalled();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(mocks.reconcileTextingUpgradeActivationForBusiness).not.toHaveBeenCalled();
  });

  it("rechecks upgrade authority immediately before a charged assignment mutation", async () => {
    mocks.assertTextingUpgradeProvisioningAllowed.mockRejectedValue(new Error("upgrade canceled"));
    await expect(ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true })).rejects.toThrow("upgrade canceled");
    expect(mocks.retrieveAssignment).toHaveBeenCalled();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(claimedPhoneIds.size).toBe(0);
  });

  it("attempts atomic upgrade activation after persisting the assigned number", async () => {
    mocks.createAssignment.mockResolvedValue({
      phoneNumber: PHONE_NUMBER, campaignId: CAMPAIGN_ID, assignmentStatus: "ASSIGNED",
    });
    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });
    expect(phoneRows[0].telnyx_campaign_assignment_status).toBe("assigned");
    expect(mocks.reconcileTextingUpgradeActivationForBusiness).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it("finishes an audited support recheck using the already-owned assigned number without a new assignment", async () => {
    phoneRows[0] = {
      ...phoneRows[0],
      telnyx_campaign_assignment_status: "assigned",
      telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
      telnyx_campaign_assigned_at: NOW,
    };
    mocks.retrieveAssignment.mockResolvedValue({
      phoneNumber: PHONE_NUMBER, campaignId: CAMPAIGN_ID, assignmentStatus: "ASSIGNED",
    });

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true, reason: "admin_recheck" });

    expect(mocks.retrieveAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(mocks.reconcileTextingUpgradeActivationForBusiness).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID);
    expect(phoneRows[0].telnyx_campaign_assignment_campaign_id).toBe(CAMPAIGN_ID);
  });

  it("still blocks an explicit staff recheck when paid support recovery has not been authorized", async () => {
    mocks.canContinueTextingUpgradeProvisioning.mockResolvedValue(false);

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true, reason: "admin_recheck" });

    expect(mocks.retrieveAssignment).not.toHaveBeenCalled();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(mocks.reconcileTextingUpgradeActivationForBusiness).not.toHaveBeenCalled();
  });
  const unsafeBusinesses: Array<[string, Partial<BusinessState>]> = [
    ["campaign not approved", { campaign_status: "rejected" }],
    ["brand not approved", { brand_status: "pending" }],
    ["missing brand", { telnyx_brand_id: "   " }],
    ["missing campaign", { telnyx_campaign_id: "   " }],
    ["missing messaging profile", { telnyx_messaging_profile_id: "   " }],
    ["deleted business", { deleted_at: "2026-07-28T09:00:00.000Z" }],
    [
      "operationally suspended business",
      { operations_suspended_at: "2026-07-28T09:00:00.000Z" },
    ],
    [
      "released uniqueness claims",
      { telnyx_unique_claims_released_at: "2026-07-28T09:00:00.000Z" },
    ],
    [
      "release in progress",
      {
        active_telnyx_release_run_id:
          "20000000-0000-4000-8000-000000000002",
      },
    ],
    ["submission kill-switch", { telnyx_submission_disabled: true }],
    ["parked resource lifecycle", { telnyx_resource_state: "parked" }],
  ];

  it.each(unsafeBusinesses)(
    "does not read phone rows or call Telnyx for %s",
    async (_label, overrides) => {
      business = safeBusiness(overrides);

      await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

      expect(businessQueries()[0]?.selection).toContain(
        "operations_suspended_at"
      );
      expect(phoneQueries()).toHaveLength(0);
      expect(mocks.retrieveAssignment).not.toHaveBeenCalled();
      expect(mocks.retrieveTaskStatus).not.toHaveBeenCalled();
      expect(mocks.createAssignment).not.toHaveBeenCalled();
      expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
      expect(
        businessQueries().filter((query) => query.operation === "update")
      ).toHaveLength(0);
    }
  );
});

describe("per-number assignment intent claim", () => {
  it("claims the exact observed row and uses only per-number provider create", async () => {
    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, {
      force: true,
      reason: "test_refresh",
    });

    const claim = intentClaimQuery();
    expect(claim.payload).toEqual({
      telnyx_campaign_assignment_status: "pending",
      telnyx_campaign_assignment_task_id: null,
      telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
      telnyx_campaign_assignment_failure_reason: null,
      telnyx_campaign_assignment_updated_at: NOW,
      telnyx_campaign_assigned_at: null,
    });
    expect(claim.filters).toEqual([
      { kind: "eq", column: "id", value: PHONE_ID },
      { kind: "eq", column: "business_id", value: BUSINESS_ID },
      { kind: "eq", column: "phone_number", value: PHONE_NUMBER },
      { kind: "eq", column: "is_active", value: true },
      { kind: "eq", column: "resource_status", value: "active" },
      {
        kind: "eq",
        column: "telnyx_campaign_assignment_status",
        value: "unassigned",
      },
      {
        kind: "is",
        column: "telnyx_campaign_assignment_campaign_id",
        value: null,
      },
      {
        kind: "is",
        column: "telnyx_campaign_assignment_task_id",
        value: null,
      },
      {
        kind: "is",
        column: "telnyx_campaign_assignment_updated_at",
        value: null,
      },
    ]);
    expect(
      businessQueries().find(
        (query) =>
          typeof query.payload
            ?.telnyx_campaign_assignment_claim_token === "string"
      )?.filters
    ).toEqual(
      expect.arrayContaining([
        {
          kind: "eq",
          column: "telnyx_brand_id",
          value: BRAND_ID,
        },
        {
          kind: "is",
          column: "operations_suspended_at",
          value: null,
        },
      ])
    );
    expect(timeline.indexOf("business_claim")).toBeLessThan(
      timeline.indexOf("phone_read")
    );
    expect(timeline.indexOf("business_claim")).toBeLessThan(
      timeline.indexOf("provider_inspect")
    );
    expect(timeline.indexOf("phone_intent_claim")).toBeLessThan(
      timeline.indexOf("provider_create")
    );
    expect(mocks.retrieveAssignment).toHaveBeenCalledWith(
      PHONE_NUMBER,
      {
        maxRetries: 0,
        timeout: 10_000,
      }
    );
    expect(mocks.createAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).toHaveBeenCalledWith(
      {
        phoneNumber: PHONE_NUMBER,
        campaignId: CAMPAIGN_ID,
      },
      {
        maxRetries: 0,
        timeout: 10_000,
      }
    );
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
  });

  it("renews through unrelated updated_at drift and creates the exact number once", async () => {
    businessUpdatedAtDriftOnPhoneRead = true;

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    const renewal = businessQueries().find(
      (query) =>
        query.operation === "update" &&
        query.selection !== null &&
        query.payload !== null &&
        !Object.prototype.hasOwnProperty.call(
          query.payload,
          "telnyx_campaign_assignment_claim_token"
        )
    );
    expect(renewal?.filters).toEqual(
      expect.arrayContaining([
        { kind: "eq", column: "telnyx_brand_id", value: BRAND_ID },
        { kind: "eq", column: "telnyx_campaign_id", value: CAMPAIGN_ID },
        {
          kind: "eq",
          column: "telnyx_messaging_profile_id",
          value: PROFILE_ID,
        },
        {
          kind: "is",
          column: "operations_suspended_at",
          value: null,
        },
      ])
    );
    expect(
      renewal?.filters.some((filter) => filter.column === "updated_at")
    ).toBe(false);
    expect(mocks.retrieveAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).toHaveBeenCalledWith(
      {
        phoneNumber: PHONE_NUMBER,
        campaignId: CAMPAIGN_ID,
      },
      {
        maxRetries: 0,
        timeout: 10_000,
      }
    );
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
  });

  it("allows only one per-number create when two callers race on one row", async () => {
    await Promise.all([
      ensureCampaignAssignmentForBusiness(BUSINESS_ID, {
        force: true,
        reason: "concurrent_a",
      }),
      ensureCampaignAssignmentForBusiness(BUSINESS_ID, {
        force: true,
        reason: "concurrent_b",
      }),
    ]);

    const businessClaimAttempts = businessQueries().filter(
      (query) =>
        query.operation === "update" &&
        typeof query.payload?.telnyx_campaign_assignment_claim_token ===
          "string"
    );
    expect(businessClaimAttempts).toHaveLength(2);
    expect(
      timeline.filter((event) => event === "phone_intent_claim")
    ).toHaveLength(1);
    expect(mocks.retrieveAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).toHaveBeenCalledOnce();
    expect(
      timeline.filter((event) => event === "provider_create")
    ).toHaveLength(1);
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
  });

  it("blocks a fresh pending no-task intent even when force is true", async () => {
    phoneRows = [
      unassignedPhone({
        telnyx_campaign_assignment_status: "pending",
        telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
        telnyx_campaign_assignment_task_id: null,
        telnyx_campaign_assignment_updated_at: new Date(
          Date.parse(NOW) - 30_000
        ).toISOString(),
      }),
    ];

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.retrieveAssignment).not.toHaveBeenCalled();
    expect(mocks.retrieveTaskStatus).not.toHaveBeenCalled();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
    expect(
      phoneQueries().filter((query) => query.operation === "update")
    ).toHaveLength(0);
  });

  it("recovers a stale pending no-task intent with an exact new claim", async () => {
    const staleIntentAt = new Date(
      Date.parse(NOW) - 2 * 60_000
    ).toISOString();
    phoneRows = [
      unassignedPhone({
        telnyx_campaign_assignment_status: "pending",
        telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
        telnyx_campaign_assignment_task_id: null,
        telnyx_campaign_assignment_updated_at: staleIntentAt,
      }),
    ];

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID);

    const claim = intentClaimQuery();
    expect(claim.filters).toEqual(
      expect.arrayContaining([
        {
          kind: "eq",
          column: "telnyx_campaign_assignment_status",
          value: "pending",
        },
        {
          kind: "eq",
          column: "telnyx_campaign_assignment_campaign_id",
          value: CAMPAIGN_ID,
        },
        {
          kind: "is",
          column: "telnyx_campaign_assignment_task_id",
          value: null,
        },
        {
          kind: "eq",
          column: "telnyx_campaign_assignment_updated_at",
          value: staleIntentAt,
        },
      ])
    );
    expect(mocks.retrieveAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).toHaveBeenCalledOnce();
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
  });

  it("releases the phone intent when the first business renewal misses", async () => {
    businessRenewalMissOnCall = 1;
    const originalPhone = { ...phoneRows[0] };

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.retrieveAssignment).not.toHaveBeenCalled();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
    const release = phoneQueries().find(
      (query) =>
        query.operation === "update" &&
        query.selection === null &&
        query.filters.some(
          (filter) =>
            filter.column === "telnyx_campaign_assignment_updated_at" &&
            filter.value === NOW
        )
    );
    expect(release?.payload).toEqual({
      telnyx_campaign_assignment_status: "unassigned",
      telnyx_campaign_assignment_task_id: null,
      telnyx_campaign_assignment_campaign_id: null,
      telnyx_campaign_assignment_failure_reason: null,
      telnyx_campaign_assignment_updated_at: null,
      telnyx_campaign_assigned_at: null,
    });
    expect(release?.filters).toEqual([
      { kind: "eq", column: "id", value: PHONE_ID },
      { kind: "eq", column: "business_id", value: BUSINESS_ID },
      { kind: "eq", column: "phone_number", value: PHONE_NUMBER },
      { kind: "eq", column: "is_active", value: true },
      { kind: "eq", column: "resource_status", value: "active" },
      {
        kind: "eq",
        column: "telnyx_campaign_assignment_status",
        value: "pending",
      },
      {
        kind: "eq",
        column: "telnyx_campaign_assignment_campaign_id",
        value: CAMPAIGN_ID,
      },
      {
        kind: "eq",
        column: "telnyx_campaign_assignment_updated_at",
        value: NOW,
      },
      {
        kind: "is",
        column: "telnyx_campaign_assignment_task_id",
        value: null,
      },
    ]);
    expect(phoneRows[0]).toEqual(originalPhone);
    expect(business).toMatchObject({
      telnyx_campaign_assignment_claim_token: null,
      telnyx_campaign_assignment_claimed_at: null,
      telnyx_campaign_assignment_claim_campaign_id: null,
      telnyx_campaign_assignment_claim_profile_id: null,
    });
  });

  it("does not inspect or create for a conflicting second local row", async () => {
    const secondPhone = unassignedPhone({
      id: SECOND_PHONE_ID,
      phone_number: SECOND_PHONE_NUMBER,
    });
    phoneRows = [unassignedPhone(), { ...secondPhone }];
    phoneClaimMissIds.add(SECOND_PHONE_ID);

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.retrieveAssignment).toHaveBeenCalledOnce();
    expect(mocks.retrieveAssignment).toHaveBeenCalledWith(
      PHONE_NUMBER,
      expect.any(Object)
    );
    expect(mocks.createAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: PHONE_NUMBER }),
      expect.any(Object)
    );
    expect(mocks.createAssignment).not.toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: SECOND_PHONE_NUMBER }),
      expect.any(Object)
    );
    expect(phoneRows[1]).toEqual(secondPhone);
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
  });

  it("fails closed when task status cannot be read", async () => {
    const staleTaskAt = new Date(
      Date.parse(NOW) - 2 * 60_000
    ).toISOString();
    phoneRows = [
      unassignedPhone({
        telnyx_campaign_assignment_status: "pending",
        telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
        telnyx_campaign_assignment_task_id: "task-123",
        telnyx_campaign_assignment_updated_at: staleTaskAt,
      }),
    ];
    mocks.retrieveTaskStatus.mockRejectedValueOnce(
      new Error("task lookup unavailable")
    );

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.retrieveTaskStatus).toHaveBeenCalledWith(
      "task-123",
      {
        maxRetries: 0,
        timeout: 10_000,
      }
    );
    expect(mocks.retrieveAssignment).not.toHaveBeenCalled();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
    expect(phoneRows[0]).toMatchObject({
      telnyx_campaign_assignment_status: "pending",
      telnyx_campaign_assignment_task_id: "task-123",
      telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
      telnyx_campaign_assignment_failure_reason: null,
      telnyx_campaign_assignment_updated_at: NOW,
    });
  });

  it("does not poll an old-campaign task and inspects the exact number instead", async () => {
    const oldTaskAt = new Date(
      Date.parse(NOW) - 2 * 60_000
    ).toISOString();
    phoneRows = [
      unassignedPhone({
        telnyx_campaign_assignment_status: "pending",
        telnyx_campaign_assignment_campaign_id: OLD_CAMPAIGN_ID,
        telnyx_campaign_assignment_task_id: "old-campaign-task",
        telnyx_campaign_assignment_updated_at: oldTaskAt,
      }),
    ];

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID);

    expect(mocks.retrieveTaskStatus).not.toHaveBeenCalled();
    expect(mocks.retrieveAssignment).toHaveBeenCalledWith(
      PHONE_NUMBER,
      {
        maxRetries: 0,
        timeout: 10_000,
      }
    );
    expect(mocks.createAssignment).toHaveBeenCalledWith(
      {
        phoneNumber: PHONE_NUMBER,
        campaignId: CAMPAIGN_ID,
      },
      {
        maxRetries: 0,
        timeout: 10_000,
      }
    );
    expect(intentClaimQuery().filters).toEqual(
      expect.arrayContaining([
        {
          kind: "eq",
          column: "telnyx_campaign_assignment_campaign_id",
          value: OLD_CAMPAIGN_ID,
        },
        {
          kind: "eq",
          column: "telnyx_campaign_assignment_task_id",
          value: "old-campaign-task",
        },
      ])
    );
    expect(phoneRows[0]).toMatchObject({
      telnyx_campaign_assignment_status: "pending",
      telnyx_campaign_assignment_task_id: null,
      telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
    });
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
  });

  it("restores the phone claim and rethrows an inspection failure", async () => {
    const originalPhone = { ...phoneRows[0] };
    mocks.retrieveAssignment.mockImplementationOnce(async () => {
      timeline.push("provider_inspect");
      throw new Error("inspection unavailable");
    });

    await expect(
      ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true })
    ).rejects.toThrow("inspection unavailable");

    expect(phoneRows[0]).toEqual(originalPhone);
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledOnce();
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "inspection_unavailable" })
    );
  });

  it("releases the intent when lifecycle changes during a task-status read", async () => {
    const staleTaskAt = new Date(
      Date.parse(NOW) - 2 * 60_000
    ).toISOString();
    const originalPhone = unassignedPhone({
      telnyx_campaign_assignment_status: "pending",
      telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
      telnyx_campaign_assignment_task_id: "task-123",
      telnyx_campaign_assignment_updated_at: staleTaskAt,
    });
    phoneRows = [{ ...originalPhone }];
    mocks.retrieveTaskStatus.mockImplementationOnce(async () => {
      business.telnyx_submission_disabled = true;
      business.updated_at = "2026-07-28T10:30:01.000Z";
      return { status: "failed" };
    });

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.retrieveTaskStatus).toHaveBeenCalledOnce();
    expect(mocks.retrieveAssignment).not.toHaveBeenCalled();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(phoneRows[0]).toEqual(originalPhone);
  });

  it("releases the intent when post-error task renewal misses", async () => {
    const staleTaskAt = new Date(
      Date.parse(NOW) - 2 * 60_000
    ).toISOString();
    const originalPhone = unassignedPhone({
      telnyx_campaign_assignment_status: "pending",
      telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
      telnyx_campaign_assignment_task_id: "task-123",
      telnyx_campaign_assignment_updated_at: staleTaskAt,
    });
    phoneRows = [{ ...originalPhone }];
    businessRenewalMissOnCall = 2;
    mocks.retrieveTaskStatus.mockRejectedValueOnce(
      new Error("task lookup unavailable")
    );

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.retrieveTaskStatus).toHaveBeenCalledOnce();
    expect(mocks.retrieveAssignment).not.toHaveBeenCalled();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(phoneRows[0]).toEqual(originalPhone);
  });

  it("keeps a no-task pending intent when create succeeds but finalization CAS misses", async () => {
    phoneFinalizationMissIds.add(PHONE_ID);

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.createAssignment).toHaveBeenCalledOnce();
    expect(phoneRows[0]).toMatchObject({
      telnyx_campaign_assignment_status: "pending",
      telnyx_campaign_assignment_task_id: null,
      telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
      telnyx_campaign_assignment_failure_reason: null,
      telnyx_campaign_assignment_updated_at: NOW,
    });
    expect(
      phoneQueries().some(
        (query) =>
          query.payload?.telnyx_campaign_assignment_status === "failed"
      )
    ).toBe(false);
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ status: "provider_outcome_unknown" })
    );
  });

  it("releases the intent when lifecycle changes during assignment inspection", async () => {
    const originalPhone = { ...phoneRows[0] };
    mocks.retrieveAssignment.mockImplementationOnce(async () => {
      timeline.push("provider_inspect");
      business.campaign_status = "rejected";
      business.updated_at = "2026-07-28T10:30:01.000Z";
      return {
        phoneNumber: PHONE_NUMBER,
        campaignId: CAMPAIGN_ID,
        assignmentStatus: "ASSIGNED",
      };
    });

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.retrieveAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
    expect(phoneRows[0]).toEqual(originalPhone);
  });

  it("releases the intent when suspension lands during assignment inspection", async () => {
    const originalPhone = { ...phoneRows[0] };
    mocks.retrieveAssignment.mockImplementationOnce(async () => {
      timeline.push("provider_inspect");
      business.operations_suspended_at = "2026-07-28T10:30:01.000Z";
      business.updated_at = "2026-07-28T10:30:01.000Z";
      return {
        phoneNumber: PHONE_NUMBER,
        campaignId: CAMPAIGN_ID,
        assignmentStatus: "ASSIGNED",
      };
    });

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.retrieveAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).not.toHaveBeenCalled();
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
    expect(phoneRows[0]).toEqual(originalPhone);
  });

  it("leaves create timeouts pending and suppresses an immediate forced retry", async () => {
    mocks.createAssignment.mockImplementationOnce(async () => {
      timeline.push("provider_create");
      throw new Error("create timed out");
    });

    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });
    await ensureCampaignAssignmentForBusiness(BUSINESS_ID, { force: true });

    expect(mocks.retrieveAssignment).toHaveBeenCalledOnce();
    expect(mocks.createAssignment).toHaveBeenCalledOnce();
    expect(mocks.bulkAssignProfile).not.toHaveBeenCalled();
    expect(phoneRows[0]).toMatchObject({
      telnyx_campaign_assignment_status: "pending",
      telnyx_campaign_assignment_task_id: null,
      telnyx_campaign_assignment_campaign_id: CAMPAIGN_ID,
      telnyx_campaign_assignment_failure_reason: null,
      telnyx_campaign_assignment_updated_at: NOW,
    });
    expect(
      phoneQueries().some(
        (query) =>
          query.payload?.telnyx_campaign_assignment_status === "failed"
      )
    ).toBe(false);
  });
});
