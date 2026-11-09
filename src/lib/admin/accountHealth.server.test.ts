import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  ADMIN_BUSINESS_HEALTH_RPC,
  AdminAccountHealthReadError,
  loadAdminAccountHealth,
  loadAdminAccountHealthList,
} from "./accountHealth.server";

const BUSINESS_ID = "10000000-0000-4000-a045-000000000001";
const SNAPSHOT_AT = "2026-08-04T12:00:00.000Z";

function rpcRow(overrides: Record<string, unknown> = {}) {
  return {
    business_id: BUSINESS_ID,
    business_name: "Health Dental",
    business_email: "owner@health.example",
    website_url: "https://health.example",
    business_type: "dentist",
    business_created_at: "2026-07-01T12:00:00.000Z",
    snapshot_at: SNAPSHOT_AT,
    deleted_at: null,
    deletion_scheduled_for: null,
    operations_suspended_at: null,
    ai_replies_paused_at: null,
    texting_paused_at: null,
    bookings_paused_at: null,
    onboarding_completed_at: "2026-07-02T12:00:00.000Z",
    onboarding_step: "complete",
    partner_id: null,
    partner_name: null,
    partner_slug: null,
    billing_mode: "stripe",
    partner_plan: null,
    billing_pilot: false,
    billing_comped: false,
    billing_exempt: false,
    telnyx_submission_disabled: false,
    sms_overage_opt_in: false,
    subscription_plan: "sms_and_chat",
    subscription_status: "active",
    subscription_cancel_at_period_end: false,
    effective_plan: "sms_and_chat",
    usage_period_start: "2026-08-01T00:00:00.000Z",
    usage_period_end: "2026-09-01T00:00:00.000Z",
    usage_included_sms_parts: 500,
    usage_inbound_sms_parts: 40,
    usage_outbound_sms_parts: 60,
    usage_inbound_mms_events: 1,
    usage_outbound_mms_events: 2,
    a2p_risk_review_status: "passed",
    a2p_risk_review_message: null,
    onboarding_registration_status: "submitted",
    onboarding_registration_started_at: "2026-07-02T10:00:00.000Z",
    brand_status: "approved",
    campaign_status: "approved",
    telnyx_messaging_profile_id: "profile-1",
    telnyx_campaign_id: "campaign-1",
    messaging_profile_configured: true,
    campaign_configured: true,
    pending_phone_number_present: false,
    pending_phone_number_failed: false,
    active_phone_count: 1,
    active_phone_number: "+13175550123",
    active_phone_assignment_status: "assigned",
    active_phone_assignment_campaign_id: "campaign-1",
    active_phone_assignment_matches_campaign: true,
    active_phone_assignment_failed: false,
    ai_configured: true,
    ai_booking_enabled: true,
    ai_booking_mode: "schedule_direct",
    web_chat_enabled: true,
    calendar_connected: true,
    provisioning_job_count: 0,
    provisioning_status: null,
    provisioning_needs_attention: false,
    provisioning_invite_failed: false,
    provisioning_lease_expired: false,
    failed_setup: false,
    failed_setup_reasons: [],
    last_activity_at: "2026-08-04T11:45:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: [], error: null });
});

describe("loadAdminAccountHealthList", () => {
  it("uses one bounded RPC and normalizes its display, billing, usage, and health facts", async () => {
    mocks.rpc.mockResolvedValue({ data: [rpcRow()], error: null });

    const records = await loadAdminAccountHealthList();

    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(ADMIN_BUSINESS_HEALTH_RPC).toBe("list_admin_business_health_v2");
    expect(mocks.rpc).toHaveBeenCalledWith(ADMIN_BUSINESS_HEALTH_RPC, {
      p_business_id: null,
      p_lifecycle: null,
      p_ownership: null,
      p_partner: null,
      p_plan: null,
      p_query: null,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      business: { id: BUSINESS_ID, name: "Health Dental" },
      subscription: {
        business_id: BUSINESS_ID,
        plan: "sms_and_chat",
        status: "active",
      },
      usage: {
        business_id: BUSINESS_ID,
        included_sms_parts: 500,
        inbound_sms_parts: 40,
        outbound_sms_parts: 60,
      },
      health: {
        operations: {
          state: "active",
          services: {
            aiReplies: { state: "active", pausedAt: null },
            texting: { state: "active", pausedAt: null },
            bookings: { state: "active", pausedAt: null },
          },
        },
        lifecycle: { state: "live" },
        billing: { subscriptionPresent: true },
        phone: { state: "ready", smsReady: true },
        ai: { state: "active" },
        booking: { state: "operational" },
        lastActivityAt: "2026-08-04T11:45:00.000Z",
      },
    });
  });

  it("loads the account list when a new signup is choosing a plan", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          onboarding_completed_at: null,
          onboarding_step: "plan_selection",
          subscription_plan: null,
          subscription_status: null,
          subscription_cancel_at_period_end: null,
          effective_plan: null,
        }),
        rpcRow({ business_id: "10000000-0000-4000-a045-000000000002" }),
      ],
      error: null,
    });

    const records = await loadAdminAccountHealthList();

    expect(records).toHaveLength(2);
    expect(records[0].subscription).toBeUndefined();
    expect(records[0].health?.lifecycle.state).toBe("onboarding");
    expect(records[1].health?.lifecycle.state).toBe("live");
  });

  it("derives effective operation state while preserving independent pause timestamps", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          operations_suspended_at: "2026-08-04T11:30:00.000Z",
          ai_replies_paused_at: "2026-08-03T09:00:00.000Z",
        }),
      ],
      error: null,
    });

    const [record] = await loadAdminAccountHealthList();

    expect(record.health?.operations).toEqual({
      state: "suspended",
      suspendedAt: "2026-08-04T11:30:00.000Z",
      services: {
        aiReplies: {
          state: "paused",
          pausedAt: "2026-08-03T09:00:00.000Z",
        },
        texting: { state: "paused", pausedAt: null },
        bookings: { state: "paused", pausedAt: null },
      },
    });
  });

  it("passes combined server filters to the same RPC", async () => {
    await loadAdminAccountHealthList({
      lifecycle: "failed_setup",
      ownership: "partner",
      partnerId: "20000000-0000-4000-a045-000000000001",
      plan: "full",
      query: "Dental",
    });

    expect(mocks.rpc).toHaveBeenCalledWith(ADMIN_BUSINESS_HEALTH_RPC, {
      p_business_id: null,
      p_lifecycle: "failed_setup",
      p_ownership: "partner",
      p_partner: "20000000-0000-4000-a045-000000000001",
      p_plan: "full",
      p_query: "Dental",
    });
  });

  it("passes the suspended account-state predicate to the v2 RPC", async () => {
    await loadAdminAccountHealthList({ lifecycle: "suspended" });

    expect(mocks.rpc).toHaveBeenCalledWith(ADMIN_BUSINESS_HEALTH_RPC, {
      p_business_id: null,
      p_lifecycle: "suspended",
      p_ownership: null,
      p_partner: null,
      p_plan: null,
      p_query: null,
    });
  });

  it("keeps past-due entitlements operational while exposing a warning fact", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          subscription_status: "past_due",
        }),
      ],
      error: null,
    });

    const [record] = await loadAdminAccountHealthList();

    expect(record.health?.billing).toMatchObject({
      state: "past_due",
      pastDue: true,
    });
    expect(record.health?.ai.state).toBe("active");
  });

  it("derives an absent subscription fact from the existing nullable plan column", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          onboarding_completed_at: null,
          onboarding_step: "business_info",
          subscription_plan: null,
          subscription_status: null,
          subscription_cancel_at_period_end: null,
          effective_plan: null,
        }),
      ],
      error: null,
    });

    const [record] = await loadAdminAccountHealthList();

    expect(record.subscription).toBeUndefined();
    expect(record.health?.lifecycle.state).toBe("onboarding");
    expect(record.health?.billing).toEqual({
      mode: "stripe",
      subscriptionPresent: false,
      plan: null,
      status: null,
      source: null,
      state: "unknown",
      pastDue: false,
      cancelAtPeriodEnd: false,
    });
  });

  it("keeps partner billing active without inventing a Stripe subscription", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          partner_id: "20000000-0000-4000-a045-000000000001",
          partner_name: "Partner Health",
          partner_slug: "partner-health",
          billing_mode: "invoiced",
          partner_plan: "sms_and_chat",
          subscription_plan: null,
          subscription_status: null,
          subscription_cancel_at_period_end: null,
          effective_plan: "sms_and_chat",
        }),
      ],
      error: null,
    });

    const [record] = await loadAdminAccountHealthList();

    expect(record.subscription).toBeUndefined();
    expect(record.health?.billing).toMatchObject({
      mode: "invoiced",
      subscriptionPresent: false,
      plan: "sms_and_chat",
      status: "partner_billing",
      source: "partner_billing",
      state: "active",
    });
  });

  it("recognizes chat-only in the authoritative admin billing read model", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          partner_id: "20000000-0000-4000-a045-000000000001",
          partner_name: "Partner Health",
          partner_slug: "partner-health",
          billing_mode: "invoiced",
          partner_plan: "chat_only",
          subscription_plan: null,
          subscription_status: null,
          subscription_cancel_at_period_end: null,
          effective_plan: "chat_only",
          usage_included_sms_parts: 0,
          usage_inbound_sms_parts: 0,
          usage_outbound_sms_parts: 0,
        }),
      ],
      error: null,
    });

    const [record] = await loadAdminAccountHealthList();

    expect(record.business.partner_plan).toBe("chat_only");
    expect(record.health?.billing).toMatchObject({
      plan: "chat_only",
      source: "partner_billing",
      state: "active",
    });
  });

  it("treats legacy nullable AI booking fields as disabled configuration", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          ai_booking_enabled: null,
          ai_booking_mode: null,
        }),
      ],
      error: null,
    });

    const [record] = await loadAdminAccountHealthList();

    expect(record.health?.ai.configured).toBe(true);
    expect(record.health?.booking).toEqual({
      mode: null,
      state: "disabled",
    });
  });

  it("preserves ambiguous phones and derives aggregate assignment failure", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          active_phone_count: 2,
          active_phone_number: null,
          active_phone_assignment_status: null,
          active_phone_assignment_campaign_id: null,
          active_phone_assignment_matches_campaign: false,
          active_phone_assignment_failed: true,
          failed_setup: true,
          failed_setup_reasons: ["phone_assignment_failed"],
        }),
      ],
      error: null,
    });

    const [record] = await loadAdminAccountHealthList();

    expect(record.health?.phone).toMatchObject({
      state: "ambiguous",
      activeCount: 2,
      smsReady: false,
    });
    expect(record.health?.failedSetup.reasons).toEqual([
      {
        code: "phone_assignment_failed",
        label: "Phone assignment failed",
      },
    ]);
  });

  it("keeps terminal rows as tombstones without normalizing scrubbed configuration", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          deleted_at: "2026-05-01T12:00:00.000Z",
          deletion_scheduled_for: null,
          onboarding_completed_at: null,
          billing_mode: "stripe",
          subscription_plan: null,
          subscription_status: null,
          subscription_cancel_at_period_end: null,
          effective_plan: null,
          usage_period_start: null,
          usage_period_end: null,
          usage_included_sms_parts: null,
          usage_inbound_sms_parts: null,
          usage_outbound_sms_parts: null,
          usage_inbound_mms_events: null,
          usage_outbound_mms_events: null,
          telnyx_messaging_profile_id: null,
          telnyx_campaign_id: null,
          messaging_profile_configured: false,
          campaign_configured: false,
          active_phone_count: 0,
          active_phone_number: null,
          active_phone_assignment_status: null,
          active_phone_assignment_campaign_id: null,
          active_phone_assignment_matches_campaign: false,
          active_phone_assignment_failed: false,
          ai_configured: false,
          ai_booking_enabled: null,
          ai_booking_mode: null,
          web_chat_enabled: false,
          calendar_connected: false,
        }),
      ],
      error: null,
    });

    const [record] = await loadAdminAccountHealthList();

    expect(record.health).toBeNull();
    expect(record.subscription).toBeUndefined();
    expect(record.usage).toBeUndefined();
  });

  it("fails closed on SQL/TypeScript health predicate drift", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow({
          pending_phone_number_failed: true,
          failed_setup: false,
          failed_setup_reasons: [],
        }),
      ],
      error: null,
    });

    await expect(loadAdminAccountHealthList()).rejects.toMatchObject({
      code: "inconsistent_response",
    });
  });

  it("rejects unexpected sensitive projection fields", async () => {
    mocks.rpc.mockResolvedValue({
      data: [rpcRow({ access_token: "must-not-leave-the-read-model" })],
      error: null,
    });

    await expect(loadAdminAccountHealthList()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it.each([
    "operations_suspended_at",
    "ai_replies_paused_at",
    "texting_paused_at",
    "bookings_paused_at",
  ])("requires the v2 %s projection field", async (field) => {
    const row: Record<string, unknown> = rpcRow();
    delete row[field];
    mocks.rpc.mockResolvedValue({ data: [row], error: null });

    await expect(loadAdminAccountHealthList()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects malformed operation timestamps from the v2 read model", async () => {
    mocks.rpc.mockResolvedValue({
      data: [rpcRow({ operations_suspended_at: "not-a-timestamp" })],
      error: null,
    });

    await expect(loadAdminAccountHealthList()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("does not reinterpret a null success payload as an empty account list", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    await expect(loadAdminAccountHealthList()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("surfaces RPC failures rather than presenting empty health", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "database unavailable" },
    });

    const promise = loadAdminAccountHealthList();
    await expect(promise).rejects.toBeInstanceOf(AdminAccountHealthReadError);
    await expect(promise).rejects.toMatchObject({ code: "query_failed" });
  });
});

describe("loadAdminAccountHealth", () => {
  it("loads a single detail snapshot by exact business ID", async () => {
    mocks.rpc.mockResolvedValue({ data: [rpcRow()], error: null });

    const health = await loadAdminAccountHealth(BUSINESS_ID);

    expect(health?.businessId).toBe(BUSINESS_ID);
    expect(mocks.rpc).toHaveBeenCalledWith(ADMIN_BUSINESS_HEALTH_RPC, {
      p_business_id: BUSINESS_ID,
      p_lifecycle: null,
      p_ownership: null,
      p_partner: null,
      p_plan: null,
      p_query: null,
    });
  });

  it("does not query for a malformed business ID", async () => {
    await expect(loadAdminAccountHealth("not-a-uuid")).resolves.toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects duplicate detail rows", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        rpcRow(),
        rpcRow({ business_name: "Duplicate Health Dental" }),
      ],
      error: null,
    });

    await expect(loadAdminAccountHealth(BUSINESS_ID)).rejects.toMatchObject({
      code: "inconsistent_response",
    });
  });
});
