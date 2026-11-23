import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/client", () => ({ resend: { emails: { send } } }));
import { sendAccountAlert, ACCOUNT_ALERT_SEND_TIMEOUT_MS } from "./sender.server";
const id = "10000000-0000-4000-a000-000000000001";
const message = { from: "sender@example.test", to: "bryan@simplassist.com" as const,
  replyTo: "alex@example.test", subject: "New signup", text: "New account", html: "<p>New account</p>" };
beforeEach(() => { vi.clearAllMocks(); send.mockResolvedValue({ data: { id: "email-1" }, error: null }); });
afterEach(() => vi.useRealTimers());
describe("account alert sender", () => {
  it("uses the same key and exact frozen request on a retry", async () => {
    expect(await sendAccountAlert(id, message)).toEqual({ kind: "accepted", providerId: "email-1" });
    await sendAccountAlert(id, message);
    for (const call of send.mock.calls) {
      expect(call[0]).toEqual(message);
      expect(call[1].idempotencyKey).toBe(`account-signup-alert-v1/${id}`);
    }
  });
  it.each(["rate_limit_exceeded", "application_error", "invalid_api_key"])("retries %s without storing sensitive provider text", async (name) => {
    send.mockResolvedValue({ data: null, error: { name, message: "private-customer-data" } });
    expect(await sendAccountAlert(id, message)).toEqual({ kind: "retry", code: "provider_not_confirmed" });
  });
  it("holds incompatible idempotency requests for review", async () => {
    send.mockResolvedValue({ data: null, error: { name: "invalid_idempotent_request" } });
    expect(await sendAccountAlert(id, message)).toEqual({ kind: "needs_review", code: "provider_invalid_request" });
  });
  it("bounds an unresponsive provider and keeps the result retryable", async () => {
    vi.useFakeTimers(); send.mockImplementation(() => new Promise(() => {}));
    const pending = sendAccountAlert(id, message);
    await vi.advanceTimersByTimeAsync(ACCOUNT_ALERT_SEND_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: "retry", code: "provider_not_confirmed" });
    expect(send.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("never sends to an injected recipient", async () => {
    await sendAccountAlert(id, { ...message, to: "attacker@example.test" } as unknown as typeof message);
    expect(send).not.toHaveBeenCalled();
  });
});
