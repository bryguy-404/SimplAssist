import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveStrictAuthCallbackOrigin: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/callbackOrigin.server", () => ({
  resolveStrictAuthCallbackOrigin: mocks.resolveStrictAuthCallbackOrigin,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mocks.getUser } })),
}));

import { GET } from "./route";

function start(code: string, host = "simplassist.com") {
  return GET(
    new NextRequest(`http://localhost:8080/gift/${code}/start`, { headers: { host } }),
    { params: { code } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveStrictAuthCallbackOrigin.mockResolvedValue({
    origin: "https://simplassist.com",
    kind: "direct",
    partnerId: null,
  });
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
});

describe("GET /gift/[code]/start", () => {
  it("remembers the code and sends a new visitor to signup", async () => {
    const response = await start("ROSA-FREEMONTH");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://simplassist.com/signup");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const cookie = response.cookies.get("sa_gift_code");
    expect(cookie).toMatchObject({
      value: "ROSA-FREEMONTH",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(cookie?.maxAge).toBeGreaterThan(24 * 60 * 60);
  });

  it("sends someone already signed in back into their setup, code remembered", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "owner-1" } }, error: null });

    const response = await start("ROSA-FREEMONTH");

    expect(response.headers.get("location")).toBe("https://simplassist.com/dashboard");
    expect(response.cookies.get("sa_gift_code")?.value).toBe("ROSA-FREEMONTH");
  });

  it("still reaches signup, without a cookie, for something that is not a code", async () => {
    const response = await start("%3Cscript%3E");

    expect(response.headers.get("location")).toBe("https://simplassist.com/signup");
    expect(response.cookies.get("sa_gift_code")).toBeUndefined();
  });

  it("still reaches signup when the session cannot be read", async () => {
    mocks.getUser.mockRejectedValue(new Error("auth down"));

    const response = await start("ROSA-FREEMONTH");

    expect(response.headers.get("location")).toBe("https://simplassist.com/signup");
  });

  it.each([
    [{ origin: "https://app.partner.example", kind: "partner", partnerId: "p1" }],
    [null],
  ])("does not exist on a partner or unknown domain (%j)", async (identity) => {
    mocks.resolveStrictAuthCallbackOrigin.mockResolvedValue(identity);

    const response = await start("ROSA-FREEMONTH", "app.partner.example");

    expect(response.status).toBe(404);
    expect(response.cookies.get("sa_gift_code")).toBeUndefined();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});
