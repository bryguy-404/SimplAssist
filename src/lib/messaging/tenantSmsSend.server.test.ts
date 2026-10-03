import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  send: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: m.from, rpc: m.rpc },
}));
vi.mock("./client", () => ({ telnyx: { messages: { send: m.send } } }));
vi.mock("@/lib/billing/usage", () => ({ preflightOutboundSms: m.usage }));
import {
  sendTenantSms,
  tenantSmsFailureOutcome,
  tenantSmsFingerprint,
  reconcileTenantSmsReceipt,
  processTenantSmsInbound,
} from "./tenantSmsSend.server";
const args = {
  businessId: "business",
  from: "+15555550101",
  to: "+15555550102",
  text: "Hello",
  messagingProfileId: "profile",
  purpose: "manual_dashboard_send" as const,
  idempotencyKey: "stable-request",
};
let row: Record<string, unknown> | null;
beforeEach(() => {
  vi.clearAllMocks();
  row = null;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  m.from.mockImplementation(() => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq"]) q[method] = () => q;
    q.maybeSingle = async () => ({ data: row, error: null });
    return q;
  });
  m.usage.mockResolvedValue({ allowed: true, periodId: "period", smsParts: 1 });
  m.rpc.mockImplementation(async (name: string, p: Record<string, unknown>) => {
    if (name === "reserve_tenant_sms") {
      row = {
        id: "reservation",
        status: "submitting",
        fingerprint: p.p_fingerprint,
        conversation_id: null,
        provider_message_id: null,
        sender: args.from,
        destination: args.to,
        messaging_profile_id: "profile",
        purpose: args.purpose,
        review_enrollment_id: null,
        created_at: "2026-10-01T00:00:00Z",
      };
      return { data: { send: true, reservation: row }, error: null };
    }
    row = {
      ...row,
      status: p.p_outcome,
      provider_message_id: p.p_provider_id,
      failure_reason: p.p_reason,
    };
    return { data: row, error: null };
  });
  m.send.mockResolvedValue({ data: { id: "provider" } });
});
describe("tenant SMS delivery boundary", () => {
  it("reserves before sending, disables SDK retries and settles accepted usage", async () => {
    const sent = await sendTenantSms(args);
    expect(sent).toMatchObject({ data: { id: "provider" }, replayed: false });
    expect(m.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      m.send.mock.invocationCallOrder[0],
    );
    expect(m.send).toHaveBeenCalledWith(
      expect.objectContaining({
        messaging_profile_id: "profile",
        webhook_url:
          "https://app.example.test/api/messaging/webhook?smsReservation=reservation",
      }),
      { maxRetries: 0, timeout: 10000 },
    );
    expect(m.rpc).toHaveBeenLastCalledWith(
      "settle_tenant_sms",
      expect.objectContaining({
        p_outcome: "accepted",
        p_provider_id: "provider",
      }),
    );
  });
  it("returns the accepted receipt on retries without spending allowance or resending", async () => {
    await sendTenantSms(args);
    m.usage.mockResolvedValue({
      allowed: false,
      reason: "usage_limit_reached",
    });
    expect((await sendTenantSms(args)).replayed).toBe(true);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.usage).toHaveBeenCalledTimes(1);
    await expect(
      sendTenantSms({ ...args, text: "Changed" }),
    ).rejects.toMatchObject({ reason: "sms_idempotency_conflict" });
  });
  it("holds uncertain sends and never calls provider again for the same request", async () => {
    m.send.mockRejectedValue(new Error("timeout"));
    await expect(sendTenantSms(args)).rejects.toMatchObject({
      outcome: "uncertain",
    });
    await expect(sendTenantSms(args)).rejects.toMatchObject({
      outcome: "uncertain",
    });
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(row?.status).toBe("uncertain");
  });
  it("definite rejection releases reservation and never silently resends the same request", async () => {
    m.send.mockRejectedValue({ status: 422 });
    await expect(sendTenantSms(args)).rejects.toMatchObject({
      outcome: "not_sent",
    });
    expect(row?.status).toBe("not_sent");
    await expect(sendTenantSms(args)).rejects.toMatchObject({
      outcome: "not_sent",
    });
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it("blocks a failed atomic reservation before provider submission", async () => {
    m.rpc.mockResolvedValue({
      data: null,
      error: { message: "sms_usage_limit_reached" },
    });
    await expect(sendTenantSms(args)).rejects.toMatchObject({
      outcome: "not_sent",
      reason: "sms_usage_limit_reached",
    });
    expect(m.send).not.toHaveBeenCalled();
  });
  it("allows safe admission retry when preflight storage fails before reservation", async () => {
    m.usage.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(sendTenantSms(args)).rejects.toMatchObject({
      outcome: "not_sent",
      reason: "sms_preflight_unavailable",
    });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
    await expect(sendTenantSms(args)).resolves.toMatchObject({
      replayed: false,
    });
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it("missing accepted provider id is uncertain and keeps quota reserved", async () => {
    m.send.mockResolvedValue({ data: {} });
    await expect(sendTenantSms(args)).rejects.toMatchObject({
      outcome: "uncertain",
    });
    expect(row?.status).toBe("uncertain");
  });
  it("database failure after provider acceptance is uncertain, not another send", async () => {
    const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation((name, p) =>
      name === "settle_tenant_sms"
        ? Promise.resolve({ data: null, error: { message: "database" } })
        : original(name, p),
    );
    await expect(sendTenantSms(args)).rejects.toMatchObject({
      outcome: "uncertain",
    });
    await expect(sendTenantSms(args)).rejects.toMatchObject({
      outcome: "uncertain",
    });
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it("matches signed receipt routing and content before resolving unknown acceptance", async () => {
    row = {
      id: "reservation",
      fingerprint: tenantSmsFingerprint(args),
      purpose: args.purpose,
      sender: args.from,
      destination: args.to,
      messaging_profile_id: "profile",
      provider_message_id: null,
      review_enrollment_id: null,
      created_at: "2026-10-01T00:00:00Z",
    };
    const payload = {
      id: "provider",
      from: { phone_number: args.from },
      to: [{ phone_number: args.to, status: "delivered" }],
      messaging_profile_id: "profile",
      text: args.text,
      received_at: "2026-10-01T00:00:01Z",
    };
    await expect(
      reconcileTenantSmsReceipt(
        { ...payload, text: "Different" },
        "reservation",
      ),
    ).rejects.toThrow("correlation");
    await expect(
      reconcileTenantSmsReceipt(
        { ...payload, messaging_profile_id: "other" },
        "reservation",
      ),
    ).rejects.toThrow("identity");
    expect(await reconcileTenantSmsReceipt(payload, "reservation")).toBe(true);
    expect(row?.status).toBe("accepted");
  });
  it("inbound STOP processing uses the tenant and conversation identity", async () => {
    m.rpc.mockResolvedValue({
      data: { keyword: "stop", reviewHeld: true },
      error: null,
    });
    expect(
      await processTenantSmsInbound({
        businessId: "business",
        messagingProfileId: "profile",
        phone: args.to,
        text: "STOP",
        conversationId: "conversation",
      }),
    ).toEqual({ keyword: "stop", reviewHeld: true });
    expect(m.rpc).toHaveBeenCalledWith(
      "tenant_sms_inbound",
      expect.objectContaining({
        p_business: "business",
        p_phone: args.to,
        p_text: "STOP",
      }),
    );
  });
  it("treats rate-limit responses as no-send and server/transport failures as uncertain", () => {
    expect(tenantSmsFailureOutcome({ status: 429 })).toBe("not_sent");
    expect(tenantSmsFailureOutcome({ status: 500 })).toBe("uncertain");
    expect(tenantSmsFailureOutcome({ status: 408 })).toBe("uncertain");
  });
});
