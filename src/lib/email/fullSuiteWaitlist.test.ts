import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("./client", () => ({
  resend: { emails: { send: mocks.send } },
  RESEND_FROM: "SimplAssist <notifications@simplassist.com>",
}));

import { sendFullSuiteWaitlistConfirmation } from "./fullSuiteWaitlist";

const INPUT = {
  signupId: "4f3e6823-e07c-4b7f-a643-ff0c2625850d",
  email: "owner@example.com",
  requestOrigin: "http://localhost:8080",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com/");
  vi.stubEnv("WAITLIST_UNSUBSCRIBE_SECRET", "s".repeat(32));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendFullSuiteWaitlistConfirmation", () => {
  it("sends the approved confirmation with a signed unsubscribe link", async () => {
    mocks.send.mockResolvedValue({
      data: { id: "email-1" },
      error: null,
    });

    await expect(
      sendFullSuiteWaitlistConfirmation(INPUT)
    ).resolves.toBe(true);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [message, options] = mocks.send.mock.calls[0];
    expect(message).toMatchObject({
      from: "SimplAssist <notifications@simplassist.com>",
      to: ["owner@example.com"],
      subject: "You’re on the Full Suite waitlist",
    });
    expect(message.text).toContain(
      "AI voice answering in English, 100 voice minutes per billing month, 2,500 SMS parts per month"
    );
    expect(message.text).toMatch(
      /https:\/\/simplassist\.com\/waitlist\/unsubscribe\?token=v1\./
    );
    expect(message.html).toContain(
      "Unsubscribe from Full Suite updates"
    );
    expect(options).toEqual({
      idempotencyKey:
        "full-suite-waitlist-confirmation-v1/4f3e6823-e07c-4b7f-a643-ff0c2625850d",
    });
  });

  it("treats a returned Resend error as a failed send", async () => {
    mocks.send.mockResolvedValue({
      data: null,
      error: { name: "rate_limit_exceeded", message: "try later" },
    });

    await expect(
      sendFullSuiteWaitlistConfirmation(INPUT)
    ).resolves.toBe(false);
  });

  it("forwards a provider deadline signal", async () => {
    mocks.send.mockResolvedValue({
      data: { id: "email-1" },
      error: null,
    });
    const controller = new AbortController();

    await expect(
      sendFullSuiteWaitlistConfirmation({
        ...INPUT,
        signal: controller.signal,
      })
    ).resolves.toBe(true);

    expect(mocks.send.mock.calls[0][1]).toMatchObject({
      idempotencyKey:
        "full-suite-waitlist-confirmation-v1/4f3e6823-e07c-4b7f-a643-ff0c2625850d",
      signal: controller.signal,
    });
  });

  it("requires a returned provider email id", async () => {
    mocks.send.mockResolvedValue({ data: null, error: null });

    await expect(
      sendFullSuiteWaitlistConfirmation(INPUT)
    ).resolves.toBe(false);
  });

  it("contains thrown provider and configuration failures", async () => {
    mocks.send.mockRejectedValue(
      new Error("owner@example.com v1.secret.signature")
    );

    await expect(
      sendFullSuiteWaitlistConfirmation(INPUT)
    ).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      "[email:fullSuiteWaitlist] confirmation send failed"
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "owner@example.com"
    );
  });
});
