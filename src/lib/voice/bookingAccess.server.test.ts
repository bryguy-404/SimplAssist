import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: m }));
import { validateVoiceBookingAccess } from "./bookingAccess.server";

const authority = { sessionId: "call", actionId: "action" };
const confirmed = { kind: "booking", name: "Caller", phone: "+13175550101", email: "caller@example.com", service: "Estimate", startTime: "2026-10-01T10:00:00" };
const request = { customerName: "Caller", customerPhone: confirmed.phone, customerEmail: confirmed.email, serviceName: "Estimate", startTime: confirmed.startTime };
let session: Record<string, unknown>;
let action: Record<string, unknown>;
let allowed: boolean;
let current: boolean;
let invited: string | null;

beforeEach(() => {
  vi.clearAllMocks();
  allowed = current = true;
  invited = confirmed.email;
  session = { business_id: "business", action_business_id: "business", demo_mode: false, caller_phone: confirmed.phone };
  action = { kind: "booking", status: "executing", business_id: "business", source_message_id: "message", payload: { ...confirmed } };
  m.rpc.mockImplementation(async (name: string) => ({ data: name === "voice_action_allowed" ? allowed : current, error: null }));
  m.from.mockImplementation((table: string) => {
    const q = {
      select: vi.fn(() => q), eq: vi.fn(() => q),
      single: async () => ({ data: table === "voice_sessions" ? session : table === "voice_actions" ? action
        : table === "voice_pilot_settings" ? { demo_business_id: "business", demo_calendar_id: "calendar" }
        : table === "google_calendar_tokens" ? { calendar_id: "calendar" }
        : { invitation_email: invited }, error: null }),
    };
    return q;
  });
});

describe("voice calendar authority", () => {
  it("uses the confirmed email for this call without accessing private contact history", async () => {
    await expect(validateVoiceBookingAccess("business", authority, "message", request)).resolves.toEqual({ email: confirmed.email });
    expect(m.from).not.toHaveBeenCalledWith("contacts");
    expect(m.rpc).toHaveBeenCalledWith("voice_action_execution_current", { p_action_id: "action" });
  });

  it("rejects another business before reading its confirmation", async () => {
    await expect(validateVoiceBookingAccess("other-business", authority, "message", request)).rejects.toThrow("voice_booking_scope_mismatch");
    expect(m.from).not.toHaveBeenCalledWith("voice_actions");
  });

  it("permits read-only availability checks but requires exact confirmation linkage for creation", async () => {
    await expect(validateVoiceBookingAccess("business", { sessionId: "call" })).resolves.toEqual({});
    await expect(validateVoiceBookingAccess("business", authority, undefined, request)).rejects.toThrow("voice_booking_confirmation_missing");
    await expect(validateVoiceBookingAccess("business", { sessionId: "call" }, "message", request)).rejects.toThrow("voice_booking_confirmation_missing");
    expect(m.from).not.toHaveBeenCalledWith("voice_actions");
  });

  it("denies unavailable booking permission and superseded caller confirmation", async () => {
    allowed = false;
    await expect(validateVoiceBookingAccess("business", authority, "message", request)).rejects.toThrow("voice_booking_not_authorized");
    allowed = true; current = false;
    await expect(validateVoiceBookingAccess("business", authority, "message", request)).rejects.toThrow("voice_booking_confirmation_superseded");
  });

  it.each([
    { business_id: "other-business" }, { source_message_id: "other-message" },
    { status: "awaiting_confirmation" }, { kind: "contact" },
  ])("rejects invalid action authority %j", async (patch) => {
    Object.assign(action, patch);
    await expect(validateVoiceBookingAccess("business", authority, "message", request)).rejects.toThrow("voice_booking_confirmation_missing");
  });

  it.each([
    { customerName: "Different Caller" }, { customerPhone: "+13175550199" },
    { customerEmail: "other@example.com" }, { serviceName: "Other Service" },
    { startTime: "2026-10-01T11:00:00" },
  ])("rejects changing confirmed booking details %j", async (patch) => {
    await expect(validateVoiceBookingAccess("business", authority, "message", { ...request, ...patch })).rejects.toThrow("voice_booking_request_not_confirmed");
  });

  it("does not accept malformed action content or a different caller phone", async () => {
    action.payload = { ...confirmed, phone: "+13175550199" };
    await expect(validateVoiceBookingAccess("business", authority, "message", request)).rejects.toThrow("voice_booking_confirmation_invalid");
    action.payload = { kind: "booking", email: confirmed.email };
    await expect(validateVoiceBookingAccess("business", authority, "message", request)).rejects.toThrow("voice_booking_confirmation_invalid");
  });

  it("permits a confirmed booking without sending an email invitation", async () => {
    action.payload = { ...confirmed, email: undefined };
    await expect(validateVoiceBookingAccess("business", authority, "message", { ...request, customerEmail: undefined })).resolves.toEqual({ email: undefined });
  });

  it("preserves the private demo invitation restriction", async () => {
    session.demo_mode = true; invited = "approved@example.com";
    await expect(validateVoiceBookingAccess("business", authority, "message", request)).rejects.toThrow("voice_demo_invitation_not_allowed");
    invited = confirmed.email;
    await expect(validateVoiceBookingAccess("business", authority, "message", request)).resolves.toEqual({ email: confirmed.email });
  });
});
