import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  schedule: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomUUID: mocks.randomUUID };
});
vi.mock("./client", () => ({
  resend: { emails: { send: mocks.send } },
  RESEND_FROM: "SimplAssist <notifications@simplassist.com>",
}));
vi.mock("./fullSuiteLaunchRateLimit", () => ({
  scheduleFullSuiteLaunchResend: mocks.schedule,
}));

import { sendFullSuiteLaunchEmail } from "./fullSuiteLaunch";

const SIGNUP_ID = "4f3e6823-e07c-4b7f-a643-ff0c2625850d";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com/");
  vi.stubEnv("WAITLIST_UNSUBSCRIBE_SECRET", "s".repeat(32));
  mocks.randomUUID.mockReturnValue("62cc7e29-ebbf-41c7-b9c5-ef3aa8dca312");
  mocks.schedule.mockImplementation(
    async (
      operation: () => Promise<unknown>,
      beforeStart?: () => Promise<boolean>
    ) => {
      if (beforeStart && !(await beforeStart())) {
        return { started: false };
      }
      return { started: true, value: await operation() };
    }
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendFullSuiteLaunchEmail", () => {
  it("sends the launch announcement with stable signup idempotency", async () => {
    mocks.send.mockResolvedValue({ data: { id: "email-1" }, error: null });

    await expect(
      sendFullSuiteLaunchEmail({
        kind: "launch",
        signupId: SIGNUP_ID,
        email: "owner@example.com",
        requestOrigin: "http://localhost:8080",
      })
    ).resolves.toBe("accepted");

    const [message, options] = mocks.send.mock.calls[0];
    expect(message).toMatchObject({
      from: "SimplAssist <notifications@simplassist.com>",
      to: ["owner@example.com"],
      subject: "Full Suite is live 🎉",
    });
    expect(message.text).toContain(
      "AI voice answering in English, 100 voice minutes per billing month, 2,500 SMS parts per month"
    );
    expect(message.text).toContain("https://simplassist.com/#pricing");
    expect(message.text).toMatch(
      /https:\/\/simplassist\.com\/waitlist\/unsubscribe\?token=v1\./
    );
    expect(options).toEqual(expect.objectContaining({
      idempotencyKey: `full-suite-launch-v1/${SIGNUP_ID}`,
      signal: expect.any(AbortSignal),
    }));
  });

  it("uses a session-recipient test subject, unique key, and non-mutating preview link", async () => {
    mocks.send.mockResolvedValue({ data: { id: "email-test" }, error: null });
    vi.stubEnv("WAITLIST_UNSUBSCRIBE_SECRET", "");

    await expect(
      sendFullSuiteLaunchEmail({
        kind: "test",
        email: "admin@example.com",
        requestOrigin: "http://localhost:8080",
      })
    ).resolves.toBe("accepted");

    const [message, options] = mocks.send.mock.calls[0];
    expect(message.to).toEqual(["admin@example.com"]);
    expect(message.subject).toBe("[TEST] Full Suite is live 🎉");
    expect(message.text).toContain(
      "https://simplassist.com/waitlist/unsubscribed?preview=1"
    );
    expect(message.text).not.toContain("token=");
    expect(options).toEqual(expect.objectContaining({
      idempotencyKey:
        "full-suite-launch-test-v1/62cc7e29-ebbf-41c7-b9c5-ef3aa8dca312",
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    "missing_required_field",
    "invalid_idempotency_key",
    "restricted_api_key",
    "invalid_api_key",
    "invalid_api_Key",
    "invalid_access",
    "invalid_parameter",
    "invalid_region",
    "rate_limit_exceeded",
    "daily_quota_exceeded",
    "monthly_quota_exceeded",
    "missing_api_key",
    "invalid_from_address",
    "invalid_attachment",
    "validation_error",
    "not_found",
    "method_not_allowed",
    "security_error",
  ])("classifies %s as a definite no-send failure", async (name) => {
    mocks.send.mockResolvedValue({
      data: null,
      error: { name, message: "owner@example.com provider detail" },
    });

    await expect(
      sendFullSuiteLaunchEmail({
        kind: "launch",
        signupId: SIGNUP_ID,
        email: "owner@example.com",
        requestOrigin: "http://localhost:8080",
      })
    ).resolves.toBe("definite_failure");
  });

  it.each([
    "application_error",
    "internal_server_error",
    "concurrent_idempotent_requests",
    "invalid_idempotent_request",
    "new_provider_error",
  ])("preserves %s as an ambiguous provider outcome", async (name) => {
    mocks.send.mockResolvedValue({
      data: null,
      error: { name, message: "owner@example.com provider detail" },
    });

    await expect(
      sendFullSuiteLaunchEmail({
        kind: "launch",
        signupId: SIGNUP_ID,
        email: "owner@example.com",
        requestOrigin: "http://localhost:8080",
      })
    ).resolves.toBe("ambiguous");
  });

  it.each([
    null,
    { id: "" },
    { id: "   " },
    { id: 42 },
  ])("treats malformed provider acceptance data as ambiguous", async (data) => {
    mocks.send.mockResolvedValue({ data, error: null });

    await expect(
      sendFullSuiteLaunchEmail({
        kind: "launch",
        signupId: SIGNUP_ID,
        email: "owner@example.com",
        requestOrigin: "http://localhost:8080",
      })
    ).resolves.toBe("ambiguous");
  });

  it("treats a thrown provider error as ambiguous without logging details", async () => {
    mocks.send
      .mockRejectedValueOnce(new Error("owner@example.com v1.secret.signature"));

    const input = {
      kind: "launch" as const,
      signupId: SIGNUP_ID,
      email: "owner@example.com",
      requestOrigin: "http://localhost:8080",
    };
    await expect(sendFullSuiteLaunchEmail(input)).resolves.toBe("ambiguous");

    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "owner@example.com"
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "signature"
    );
  });

  it("aborts a provider request at the deadline and preserves an ambiguous outcome", async () => {
    vi.useFakeTimers();
    mocks.send.mockReturnValue(new Promise(() => undefined));

    const send = sendFullSuiteLaunchEmail({
      kind: "launch",
      signupId: SIGNUP_ID,
      email: "owner@example.com",
      requestOrigin: "http://localhost:8080",
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(send).resolves.toBe("ambiguous");

    const options = mocks.send.mock.calls[0][1];
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(true);
  });

  it("runs preflight inside the scheduler and never calls Resend when cancelled", async () => {
    const beforeProviderSend = vi.fn().mockResolvedValue(false);

    await expect(
      sendFullSuiteLaunchEmail(
        {
          kind: "launch",
          signupId: SIGNUP_ID,
          email: "owner@example.com",
          requestOrigin: "http://localhost:8080",
        },
        beforeProviderSend
      )
    ).resolves.toBe("cancelled");

    expect(beforeProviderSend).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("classifies local message-construction failure as definite before scheduling", async () => {
    vi.stubEnv("WAITLIST_UNSUBSCRIBE_SECRET", "");

    await expect(
      sendFullSuiteLaunchEmail({
        kind: "launch",
        signupId: SIGNUP_ID,
        email: "owner@example.com",
        requestOrigin: "http://localhost:8080",
      })
    ).resolves.toBe("definite_failure");

    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
