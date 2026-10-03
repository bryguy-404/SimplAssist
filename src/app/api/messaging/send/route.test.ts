import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  gate: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  route: vi.fn(),
  send: vi.fn(),
  entitlements: vi.fn(),
  access: vi.fn(),
  rollout: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: m.from, rpc: m.rpc },
}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspaceRouteAccess: m.gate,
  requireFreshWorkspaceRouteAccess: m.gate,
}));
vi.mock("@/lib/billing/customerReviewsRollout.server", () => ({
  customerWorkspaceEnabled: m.rollout,
}));
vi.mock("@/lib/messaging/lookup", () => ({
  getOutboundSendContext: m.route,
  smsBlockCode: () => "campaign_not_approved",
  smsBlockMessage: () => "Carrier approval required",
}));
vi.mock("@/lib/billing/entitlements", () => ({
  resolveBusinessEntitlements: m.entitlements,
  decideFeatureAccess: m.access,
}));
vi.mock("@/lib/messaging/tenantSmsSend.server", () => ({
  sendTenantSms: m.send,
  TenantSmsSendError: class extends Error {
    constructor(
      public reason: string,
      public outcome: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
import { TenantSmsSendError } from "@/lib/messaging/tenantSmsSend.server";
import { GET, POST } from "./route";
const businessId = "10000000-0000-4000-a097-000000000001";
const conversationId = "50000000-0000-4000-a097-000000000001";
const requestId = "60000000-0000-4000-a097-000000000001";
const body = {
  businessId,
  conversationId,
  requestId,
  to: "+15555550102",
  message: "Hello",
};
let rows: Record<string, { data: unknown; error: unknown }>;
let calls: Array<{ table: string; method: string; values: unknown[] }>;
function request(patch: Record<string, unknown> = {}) {
  return new NextRequest("https://app.example.test/api/messaging/send", {
    method: "POST",
    body: JSON.stringify({ ...body, ...patch }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  m.gate.mockResolvedValue({
    ok: true,
    access: { business: { id: businessId }, user: { id: "owner" } },
  });
  m.rollout.mockReturnValue(false);
  m.access.mockReturnValue({ allowed: true });
  m.entitlements.mockResolvedValue({});
  m.rpc.mockResolvedValue({ data: true, error: null });
  m.route.mockResolvedValue({
    businessId,
    smsReady: true,
    messagingProfileId: "profile",
  });
  m.send.mockResolvedValue({
    data: { id: "provider" },
    reservationId: "reservation",
    replayed: false,
  });
  rows = {
    conversations: {
      data: {
        id: conversationId,
        channel: "sms",
        is_ai_handling: false,
        contact: { phone_number: body.to },
      },
      error: null,
    },
    phone_numbers: { data: { phone_number: "+15555550101" }, error: null },
    tenant_sms_human_holds: { data: { destination: body.to }, error: null },
    messages: {
      data: { id: "message", created_at: "2026-10-01T00:00:00Z" },
      error: null,
    },
  };
  m.from.mockImplementation((table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "insert", "update"])
      q[method] = (...values: unknown[]) => {
        calls.push({ table, method, values });
        return q;
      };
    q.maybeSingle = async () => rows[table];
    q.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(rows[table]).then(resolve);
    return q;
  });
});
describe("owner SMS boundary", () => {
  it("requires fresh workspace authorization before any provider work", async () => {
    m.gate.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await POST(request())).status).toBe(401);
    expect(m.from).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });
  it("derives the tenant from workspace and rejects injected tenant IDs", async () => {
    expect((await POST(request({ businessId: "other" }))).status).toBe(400);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("requires stable request and conversation IDs", async () => {
    expect((await POST(request({ requestId: undefined }))).status).toBe(400);
    expect((await POST(request({ conversationId: "bad" }))).status).toBe(400);
  });
  it("does not allow a valid conversation to authorize another destination", async () => {
    expect((await POST(request({ to: "+15555550999" }))).status).toBe(404);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("requires Human mode and the entitled normal SMS feature", async () => {
    rows.conversations.data = {
      ...(rows.conversations.data as object),
      is_ai_handling: true,
    };
    expect((await POST(request())).status).toBe(409);
    rows.conversations.data = {
      ...(rows.conversations.data as object),
      is_ai_handling: false,
    };
    m.access.mockReturnValue({ allowed: false });
    expect((await POST(request())).status).toBe(403);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("allows Chat human replies only on an established held review conversation", async () => {
    m.rollout.mockReturnValue(true);
    m.access.mockReturnValue({ allowed: false });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(m.send).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId,
        conversationId,
        purpose: "review_reply",
        idempotencyKey: `dashboard:${requestId}`,
      }),
    );
    rows.tenant_sms_human_holds.data = null;
    expect((await POST(request())).status).toBe(403);
  });
  it("uses the real held callback destination for a captured web-chat customer", async () => {
    m.rollout.mockReturnValue(true);
    m.access.mockReturnValue({ allowed: false });
    rows.conversations.data = {
      ...(rows.conversations.data as object),
      contact: {
        phone_number: "session_unverified",
        provided_phone_number: "(555) 555-0102",
      },
    };
    const eligible = await GET(
      new NextRequest(
        `https://app.example.test/api/messaging/send?conversationId=${conversationId}`,
      ),
    );
    expect(await eligible.json()).toEqual({
      reviewReplyAllowed: true,
      destination: body.to,
    });
    expect((await POST(request())).status).toBe(200);
    expect(m.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: body.to, purpose: "review_reply" }),
    );
  });
  it("does not use a held review conversation to authorize a different stored number", async () => {
    m.rollout.mockReturnValue(true);
    rows.conversations.data = {
      ...(rows.conversations.data as object),
      contact: { phone_number: body.to, provided_phone_number: "+15555550999" },
    };
    expect((await POST(request({ to: "+15555550999" }))).status).toBe(409);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("fails closed when review access lookup fails", async () => {
    m.rollout.mockReturnValue(true);
    m.rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    expect((await POST(request())).status).toBe(503);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("blocks unapproved carrier setup and cross-tenant sending numbers", async () => {
    m.route.mockResolvedValue({ smsReady: false, businessId });
    expect((await POST(request())).status).toBe(403);
    m.route.mockResolvedValue({
      smsReady: true,
      businessId: "other",
      messagingProfileId: "profile",
    });
    expect((await POST(request())).status).toBe(403);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("persists the transcript with reservation identity after acceptance", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(m.send).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "manual_dashboard_send" }),
    );
    expect(calls).toContainEqual({
      table: "messages",
      method: "insert",
      values: [
        expect.objectContaining({
          provider_event_id: "tenant-sms:reservation",
          business_id: businessId,
        }),
      ],
    });
  });
  it("an already stored retry transcript is successful", async () => {
    rows.messages.error = { code: "23505" };
    // Select succeeds while duplicate insert reports the unique-key conflict.
    const original = m.from.getMockImplementation()!;
    m.from.mockImplementation((table) => {
      const q = original(table) as Record<string, unknown>;
      if (table === "messages")
        q.maybeSingle = async () => ({
          data: { id: "existing", created_at: "2026-10-01" },
          error: null,
        });
      return q;
    });
    const r = await POST(request());
    expect((await r.json()).messageRecord.id).toBe("existing");
  });
  it("returns accepted status when transcript persistence fails, preventing an unsafe resend", async () => {
    rows.messages = { data: null, error: { code: "offline" } };
    const r = await POST(request());
    expect(r.status).toBe(200);
    expect((await r.json()).transcriptPending).toBe(true);
  });
  it("returns unknown acceptance without pretending it was not sent", async () => {
    m.send.mockRejectedValue(
      new TenantSmsSendError(
        "sms_acceptance_unknown",
        "uncertain",
        "Do not resend",
      ),
    );
    const r = await POST(request());
    expect(r.status).toBe(409);
    expect((await r.json()).outcome).toBe("uncertain");
    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });
  it("returns definite suppression/quota rejection without creating a transcript", async () => {
    m.send.mockRejectedValue(
      new TenantSmsSendError(
        "sms_recipient_opted_out",
        "not_sent",
        "Opted out",
      ),
    );
    expect((await POST(request())).status).toBe(403);
    expect(calls.some((c) => c.table === "messages")).toBe(false);
  });
  it("GET exposes only current business held-review eligibility", async () => {
    m.rollout.mockReturnValue(true);
    const r = await GET(
      new NextRequest(
        `https://app.example.test/api/messaging/send?conversationId=${conversationId}`,
      ),
    );
    expect((await r.json()).reviewReplyAllowed).toBe(true);
    expect(calls).toContainEqual({
      table: "tenant_sms_human_holds",
      method: "eq",
      values: ["business_id", businessId],
    });
  });
});
