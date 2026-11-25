import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAdminUser: vi.fn(),
  lookupGiftCode: vi.fn(),
  sendGiftCodeEmail: vi.fn(),
  from: vi.fn(),
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  earlier: { data: null as { sent_at: string } | null, error: null as { message: string } | null },
  insertError: null as { message: string } | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/admin/auth", () => ({ getAdminUser: mocks.getAdminUser }));
vi.mock("@/lib/gift/lookup.server", () => ({ lookupGiftCode: mocks.lookupGiftCode }));
vi.mock("@/lib/email/giftCode", () => ({ sendGiftCodeEmail: mocks.sendGiftCodeEmail }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));

import { POST } from "./route";

const ADMIN = { id: "00000000-0000-4000-8000-000000000999", email: "bryan@simplassist.com" };
const AVAILABLE = {
  status: "available",
  code: "ROSA-FREEMONTH",
  promotionCodeId: "promo_1AbCdEf",
  offer: { kind: "percent", percentOff: 100, duration: "once", months: null },
  expiresAt: "2027-01-31T23:59:59.000Z",
};

function request(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new NextRequest("https://simplassist.com/api/admin/gift-codes", {
    method: "POST",
    headers: {
      host: "simplassist.com",
      origin: "https://simplassist.com",
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const send = (extra: Record<string, unknown> = {}) =>
  request({ action: "send", email: "Rosa@Example.com", firstName: " Rosa ", code: "rosa-freemonth", ...extra });

function expectNothingHappened() {
  expect(mocks.lookupGiftCode).not.toHaveBeenCalled();
  expect(mocks.sendGiftCodeEmail).not.toHaveBeenCalled();
  expect(mocks.from).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.inserts.length = 0;
  mocks.updates.length = 0;
  mocks.earlier = { data: null, error: null };
  mocks.insertError = null;
  mocks.getAdminUser.mockResolvedValue(ADMIN);
  mocks.lookupGiftCode.mockResolvedValue(AVAILABLE);
  mocks.sendGiftCodeEmail.mockResolvedValue({ id: "email_123" });
  mocks.from.mockImplementation((table: string) => {
    expect(table).toBe("gift_code_sends");
    const select: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit"]) select[method] = vi.fn(() => select);
    select.maybeSingle = vi.fn(async () => mocks.earlier);
    return {
      ...select,
      insert: vi.fn(async (row: Record<string, unknown>) => {
        mocks.inserts.push(row);
        return { error: mocks.insertError };
      }),
      update: vi.fn((values: Record<string, unknown>) => {
        mocks.updates.push(values);
        return { eq: vi.fn(async () => ({ error: null })) };
      }),
    };
  });
});

describe("POST /api/admin/gift-codes authorisation", () => {
  it.each(["preview", "send"])("answers 404 to a non-admin and does nothing (%s)", async (action) => {
    mocks.getAdminUser.mockResolvedValue(null);

    const response = await POST(request({ action, email: "rosa@example.com", code: "ROSA-FREEMONTH" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expectNothingHappened();
  });

  it("does not read the request body before the admin check", async () => {
    mocks.getAdminUser.mockResolvedValue(null);
    const guarded = send();
    const json = vi.spyOn(guarded, "json");

    await POST(guarded);

    expect(json).not.toHaveBeenCalled();
  });

  it("refuses an admin's request sent from another site", async () => {
    const crossSite = await POST(
      request(
        { action: "send", email: "rosa@example.com", code: "ROSA-FREEMONTH" },
        { origin: "https://evil.example" },
      ),
    );

    expect(crossSite.status).toBe(403);
    expectNothingHappened();
  });

  it("refuses an admin session presented on a non-canonical host", async () => {
    const response = await POST(
      request(
        { action: "send", email: "rosa@example.com", code: "ROSA-FREEMONTH" },
        { host: "app.partner.example" },
      ),
    );

    expect(response.status).toBe(404);
    expectNothingHappened();
  });

  it("refuses a body that is not JSON, or has unexpected fields", async () => {
    const form = await POST(request("action=send", { "content-type": "application/x-www-form-urlencoded" }));
    expect(form.status).toBe(400);

    const broken = await POST(request("{"));
    expect(broken.status).toBe(400);

    const extra = await POST(send({ html: "<p>my own email</p>" }));
    expect(extra.status).toBe(400);

    const badEmail = await POST(request({ action: "send", email: "not-an-email", code: "ROSA-FREEMONTH" }));
    expect(badEmail.status).toBe(400);

    expectNothingHappened();
  });

  it("never lets the response be cached", async () => {
    const response = await POST(request({ action: "preview", email: "rosa@example.com", code: "ROSA-FREEMONTH" }));
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});

describe("POST /api/admin/gift-codes preview", () => {
  it("returns the exact email after checking the code with Stripe, and sends nothing", async () => {
    const response = await POST(
      request({ action: "preview", email: "Rosa@Example.com", firstName: "Rosa", code: " rosa-freemonth " }),
    );

    expect(response.status).toBe(200);
    const { preview } = await response.json();
    expect(mocks.lookupGiftCode).toHaveBeenCalledWith("rosa-freemonth");
    expect(preview).toMatchObject({
      to: "rosa@example.com",
      code: "ROSA-FREEMONTH",
      offer: "your first month free",
      expiresAt: "2027-01-31T23:59:59.000Z",
      giftUrl: "https://simplassist.com/gift/ROSA-FREEMONTH",
      subject: "Rosa, here’s your free month of SimplAssist",
    });
    expect(preview.html).toContain("ROSA-FREEMONTH");
    expect(mocks.sendGiftCodeEmail).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/gift-codes send", () => {
  it("records the send first, then emails the code Stripe confirmed", async () => {
    const response = await POST(send());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sent: { to: "rosa@example.com", code: "ROSA-FREEMONTH" } });
    expect(mocks.inserts).toHaveLength(1);
    expect(mocks.inserts[0]).toMatchObject({
      recipient_email: "rosa@example.com",
      recipient_first_name: "Rosa",
      code: "ROSA-FREEMONTH",
      stripe_promotion_code_id: "promo_1AbCdEf",
      offer_summary: "your first month free",
      code_expires_at: "2027-01-31T23:59:59.000Z",
      sent_by: ADMIN.id,
      sent_by_email: ADMIN.email,
      status: "pending",
    });
    const sendId = mocks.inserts[0].id;
    expect(mocks.sendGiftCodeEmail).toHaveBeenCalledTimes(1);
    const sent = mocks.sendGiftCodeEmail.mock.calls[0][0];
    expect(sent.recipient).toBe("rosa@example.com");
    expect(sent.idempotencyKey).toBe(`gift-code-send-v1/${sendId}`);
    expect(sent.email.html).toContain("https://simplassist.com/gift/ROSA-FREEMONTH");
    expect(mocks.updates).toEqual([
      { status: "sent", sent_at: expect.any(String), resend_email_id: "email_123" },
    ]);
  });

  it.each([
    [{ status: "unavailable" }, 422, "code_unavailable"],
    [{ status: "error" }, 502, "stripe_unavailable"],
  ])("sends nothing when Stripe does not confirm the code (%j)", async (lookup, status, error) => {
    mocks.lookupGiftCode.mockResolvedValue(lookup);

    const response = await POST(send());

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(mocks.sendGiftCodeEmail).not.toHaveBeenCalled();
    expect(mocks.inserts).toHaveLength(0);
  });

  it("sends nothing when the send cannot be recorded", async () => {
    mocks.insertError = { message: 'relation "gift_code_sends" does not exist' };

    const response = await POST(send());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "send_log_unavailable" });
    expect(mocks.sendGiftCodeEmail).not.toHaveBeenCalled();
  });

  it("asks before emailing the same person the same code twice", async () => {
    mocks.earlier = { data: { sent_at: "2026-11-20T10:00:00.000Z" }, error: null };

    const response = await POST(send());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "already_sent", sentAt: "2026-11-20T10:00:00.000Z" });
    expect(mocks.sendGiftCodeEmail).not.toHaveBeenCalled();
    expect(mocks.inserts).toHaveLength(0);

    const again = await POST(send({ sendAgain: true }));
    expect(again.status).toBe(200);
    expect(mocks.sendGiftCodeEmail).toHaveBeenCalledTimes(1);
  });

  it("marks the record as not sent when the email provider refuses", async () => {
    mocks.sendGiftCodeEmail.mockRejectedValue(new Error("gift_code_email_send_failed"));

    const response = await POST(send());

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "email_failed" });
    expect(mocks.updates).toEqual([{ status: "failed" }]);
  });
});
