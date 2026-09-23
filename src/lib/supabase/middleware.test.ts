import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each createServerClient call is captured with its options and auth spies.
// Customer getClaims and admin getUser behavior are scripted independently so
// a test cannot accidentally exercise or rotate the wrong auth channel.
const mocks = vi.hoisted(() => ({
  clients: [] as {
    url: string;
    key: string;
    options: Record<string, unknown>;
    getClaims: ReturnType<typeof vi.fn>;
    getUser: ReturnType<typeof vi.fn>;
  }[],
  script: [] as {
    user: { id: string } | null;
    claims: Record<string, unknown> | null;
    claimsError?: { message: string } | null;
    rotateOnClaims?: {
      name: string;
      value: string;
      options: Record<string, unknown>;
    }[];
    rotateOnUser?: {
      name: string;
      value: string;
      options: Record<string, unknown>;
    }[];
    userError?: { message: string } | null;
    signOutError?: { message: string } | null;
    signOutCalls: { scope?: string }[];
  }[],
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (url: string, key: string, options: Record<string, unknown>) => {
      const index = mocks.clients.length;
      const behavior = mocks.script[index];
      if (!behavior) throw new Error(`no scripted behavior for client ${index}`);
      const cookieHandlers = options.cookies as {
        setAll: (
          cookies: { name: string; value: string; options: Record<string, unknown> }[]
        ) => void;
      };
      const getClaims = vi.fn(async () => {
        if (behavior.rotateOnClaims) {
          cookieHandlers.setAll(behavior.rotateOnClaims);
        }
        return {
          data: behavior.claims ? { claims: behavior.claims } : null,
          error: behavior.claimsError ?? null,
        };
      });
      const getUser = vi.fn(async () => {
        if (behavior.rotateOnUser) cookieHandlers.setAll(behavior.rotateOnUser);
        return {
          data: { user: behavior.user },
          error: behavior.userError ?? null,
        };
      });
      mocks.clients.push({ url, key, options, getClaims, getUser });
      return {
        auth: {
          getClaims,
          getUser,
          signOut: vi.fn(async (opts: { scope?: string }) => {
            behavior.signOutCalls.push(opts);
            return { error: behavior.signOutError ?? null };
          }),
        },
      };
    }
  ),
}));

import { updateSession } from "./middleware";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function scriptClient(
  user: { id: string } | null,
  extras: Partial<(typeof mocks.script)[number]> = {}
) {
  mocks.script.push({
    user,
    claims: user ? { sub: user.id } : null,
    signOutCalls: [],
    ...extras,
  });
}

function makeRequest(
  path: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
) {
  const requestHeaders = new Headers(init?.headers);
  if (!requestHeaders.has("host")) requestHeaders.set("host", "localhost:3000");

  return new NextRequest(`http://localhost${path}`, {
    ...init,
    headers: requestHeaders,
  });
}

const PREVIEW_COOKIE = "sa-admin-brand-preview";
const PREVIEW_HEADER = "x-sa-brand-preview";
const FORWARDED_PREVIEW_HEADER = `x-middleware-request-${PREVIEW_HEADER}`;

beforeEach(() => {
  mocks.clients.length = 0;
  mocks.script.length = 0;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.local");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("SIMPLASSIST_ADMIN_USER_IDS", ADMIN_ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("updateSession", () => {
  it("uses getClaims only for the customer channel on non-admin paths", async () => {
    scriptClient({ id: OTHER_ID });
    await updateSession(makeRequest("/dashboard"));
    expect(mocks.clients).toHaveLength(1);
    expect(mocks.clients[0].options.cookieOptions).toBeUndefined();
    expect(mocks.clients[0].getClaims).toHaveBeenCalledOnce();
    expect(mocks.clients[0].getUser).not.toHaveBeenCalled();
  });

  it("keeps authoritative getUser for the admin channel", async () => {
    scriptClient({ id: OTHER_ID });
    scriptClient({ id: ADMIN_ID });
    await updateSession(makeRequest("/admin/tickets"));
    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[0].options.cookieOptions).toBeUndefined();
    expect(mocks.clients[1].options.cookieOptions).toMatchObject({
      name: "sa-admin-auth",
    });
    expect(mocks.clients[0].getClaims).toHaveBeenCalledOnce();
    expect(mocks.clients[0].getUser).not.toHaveBeenCalled();
    expect(mocks.clients[1].getClaims).not.toHaveBeenCalled();
    expect(mocks.clients[1].getUser).toHaveBeenCalledOnce();
  });

  it("applies BOTH clients' rotated cookies to the single response", async () => {
    scriptClient(
      { id: OTHER_ID },
      {
        rotateOnClaims: [
          {
            name: "sb-ref-auth-token",
            value: "customer-rotated",
            options: {},
          },
        ],
      }
    );
    scriptClient(
      { id: ADMIN_ID },
      {
        rotateOnUser: [
          { name: "sa-admin-auth", value: "admin-rotated", options: {} },
        ],
      }
    );
    const request = makeRequest("/admin");
    const response = await updateSession(request);
    const names = response.cookies.getAll().map((cookie) => cookie.name);
    expect(names).toContain("sb-ref-auth-token");
    expect(names).toContain("sa-admin-auth");
    expect(response.cookies.get("sb-ref-auth-token")?.value).toBe(
      "customer-rotated"
    );
    expect(response.cookies.get("sa-admin-auth")?.value).toBe("admin-rotated");
    expect(request.cookies.get("sb-ref-auth-token")?.value).toBe(
      "customer-rotated"
    );
    expect(request.cookies.get("sa-admin-auth")?.value).toBe("admin-rotated");
  });

  it("continues normally when the customer session is missing", async () => {
    scriptClient(null);

    await expect(
      updateSession(makeRequest("/dashboard"))
    ).resolves.toBeDefined();
    expect(mocks.clients[0].getClaims).toHaveBeenCalledOnce();
    expect(mocks.clients[0].getUser).not.toHaveBeenCalled();
  });

  it("leaves authorization to downstream gates when claims validation returns an error", async () => {
    scriptClient(null, {
      claimsError: { message: "invalid signature" },
    });

    await expect(
      updateSession(makeRequest("/dashboard"))
    ).resolves.toBeDefined();
    expect(mocks.clients[0].getUser).not.toHaveBeenCalled();
  });

  it("still performs the admin allowlist check when customer claims fail", async () => {
    scriptClient(null, {
      claimsError: { message: "JWKS unavailable" },
    });
    scriptClient({ id: ADMIN_ID });

    await expect(updateSession(makeRequest("/admin"))).resolves.toBeDefined();
    expect(mocks.clients[0].getClaims).toHaveBeenCalledOnce();
    expect(mocks.clients[1].getUser).toHaveBeenCalledOnce();
  });

  it("signs out a non-allowlisted admin-channel session with scope local", async () => {
    scriptClient(null);
    scriptClient({ id: OTHER_ID });
    await updateSession(makeRequest("/api/admin/business-flags"));
    expect(mocks.script[1].signOutCalls).toEqual([{ scope: "local" }]);
    expect(mocks.script[0].signOutCalls).toEqual([]);
  });

  it("never signs out an allowlisted admin-channel session", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });
    await updateSession(makeRequest("/admin"));
    expect(mocks.script[1].signOutCalls).toEqual([]);
  });

  it("logs and continues when revoking a non-allowlisted session fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    scriptClient(null);
    scriptClient({ id: OTHER_ID }, { signOutError: { message: "rate limited" } });
    const response = await updateSession(makeRequest("/admin"));
    expect(response).toBeDefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to revoke"),
      "rate limited"
    );
    consoleError.mockRestore();
  });

  it("strips a forged preview header from the downstream request", async () => {
    scriptClient(null);

    const response = await updateSession(
      makeRequest("/login", {
        headers: { [PREVIEW_HEADER]: "alpha-dog" },
      }),
    );

    expect(response.headers.get(PREVIEW_HEADER)).toBeNull();
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
    expect(response.headers.get("cache-control")).toBeNull();
    expect(mocks.clients).toHaveLength(1);
  });

  it("authorizes a valid query through the admin channel and sets a host-only preview cookie", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });

    const response = await updateSession(makeRequest("/login?brand=alpha-dog"));
    const cookie = response.cookies.get(PREVIEW_COOKIE);

    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[0].getUser).not.toHaveBeenCalled();
    expect(mocks.clients[1].getUser).toHaveBeenCalledOnce();
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBe("alpha-dog");
    expect(response.headers.get(PREVIEW_HEADER)).toBeNull();
    expect(cookie).toMatchObject({
      name: PREVIEW_COOKIE,
      value: "alpha-dog",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1800,
    });
    expect(cookie).not.toHaveProperty("domain");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("accepts canonical preview Host normalization for case, port, and a final DNS dot", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });

    const response = await updateSession(
      makeRequest("/login?brand=alpha-dog", {
        headers: { host: "LOCALHOST.:8443" },
      }),
    );

    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[1].getUser).toHaveBeenCalledOnce();
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBe("alpha-dog");
    expect(response.cookies.get(PREVIEW_COOKIE)?.value).toBe("alpha-dog");
  });

  it.each([
    ["a partner host", "app.alphadogagency.ai"],
    ["an unknown host", "unknown.example"],
    ["a suffix lookalike", "localhost.evil.example"],
    ["a malformed Host", "https://localhost:3000/path"],
  ])(
    "clears preview without creating an admin client solely for %s",
    async (_, host) => {
      scriptClient(null);

      const response = await updateSession(
        makeRequest("/login?brand=alpha-dog", {
          headers: {
            host,
            cookie: `${PREVIEW_COOKIE}=existing-partner`,
          },
        }),
      );

      expect(mocks.clients).toHaveLength(1);
      expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
      expect(response.cookies.get(PREVIEW_COOKIE)).toMatchObject({
        value: "",
        maxAge: 0,
      });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
    },
  );

  it("clears preview when Host is missing without creating an admin client", async () => {
    scriptClient(null);
    const request = new NextRequest("http://localhost/login?brand=alpha-dog", {
      headers: { cookie: `${PREVIEW_COOKIE}=existing-partner` },
    });

    const response = await updateSession(request);

    expect(mocks.clients).toHaveLength(1);
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
    expect(response.cookies.get(PREVIEW_COOKIE)?.maxAge).toBe(0);
  });

  it("ignores forwarded hosts when the actual Host is canonical", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });

    const response = await updateSession(
      makeRequest("/login?brand=alpha-dog", {
        headers: {
          host: "localhost:3000",
          "x-forwarded-host": "app.alphadogagency.ai",
          forwarded: "host=app.alphadogagency.ai",
        },
      }),
    );

    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBe("alpha-dog");
  });

  it("does not let a forwarded canonical host authorize preview on a partner Host", async () => {
    scriptClient(null);

    const response = await updateSession(
      makeRequest("/login?brand=alpha-dog", {
        headers: {
          host: "app.alphadogagency.ai",
          "x-forwarded-host": "localhost:3000",
          forwarded: "host=localhost:3000",
        },
      }),
    );

    expect(mocks.clients).toHaveLength(1);
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
    expect(response.cookies.get(PREVIEW_COOKIE)?.maxAge).toBe(0);
  });

  it("clears a noncanonical preview cookie without consulting the admin channel", async () => {
    scriptClient(null);

    const response = await updateSession(
      makeRequest("/dashboard", {
        headers: {
          host: "app.alphadogagency.ai",
          cookie: `${PREVIEW_COOKIE}=alpha-dog`,
        },
      }),
    );

    expect(mocks.clients).toHaveLength(1);
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
    expect(response.cookies.get(PREVIEW_COOKIE)?.maxAge).toBe(0);
  });

  it("preserves admin-path refresh on a noncanonical Host without authorizing preview", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });

    const response = await updateSession(
      makeRequest("/admin?brand=alpha-dog", {
        headers: {
          host: "app.alphadogagency.ai",
          cookie: `${PREVIEW_COOKIE}=existing-partner`,
        },
      }),
    );

    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[1].getUser).toHaveBeenCalledOnce();
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
    expect(response.cookies.get(PREVIEW_COOKIE)?.maxAge).toBe(0);
  });

  it("passes an authorized preview cookie downstream without extending its lifetime", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });

    const response = await updateSession(
      makeRequest("/dashboard", {
        headers: { cookie: `${PREVIEW_COOKIE}=alpha-dog` },
      }),
    );

    expect(mocks.clients[1].getUser).toHaveBeenCalledOnce();
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBe("alpha-dog");
    expect(response.cookies.get(PREVIEW_COOKIE)).toBeUndefined();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("never lets an allowlisted customer-channel session authorize preview", async () => {
    scriptClient({ id: ADMIN_ID });
    scriptClient(null, { userError: { message: "Auth session missing!" } });

    const response = await updateSession(
      makeRequest("/dashboard?brand=alpha-dog", {
        headers: { cookie: `${PREVIEW_COOKIE}=old-partner` },
      }),
    );

    expect(mocks.clients[0].getClaims).toHaveBeenCalledOnce();
    expect(mocks.clients[0].getUser).not.toHaveBeenCalled();
    expect(mocks.clients[1].getUser).toHaveBeenCalledOnce();
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
    expect(response.cookies.get(PREVIEW_COOKIE)).toMatchObject({
      value: "",
      maxAge: 0,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
    });
  });

  it("clears preview when the admin session is invalid", async () => {
    scriptClient(null);
    scriptClient(null, { userError: { message: "invalid refresh token" } });

    const response = await updateSession(
      makeRequest("/signup", {
        headers: { cookie: `${PREVIEW_COOKIE}=alpha-dog` },
      }),
    );

    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
    expect(response.cookies.get(PREVIEW_COOKIE)?.maxAge).toBe(0);
  });

  it("clears preview and revokes a non-allowlisted admin-channel session", async () => {
    scriptClient(null);
    scriptClient({ id: OTHER_ID });

    const response = await updateSession(
      makeRequest("/signup", {
        headers: { cookie: `${PREVIEW_COOKIE}=alpha-dog` },
      }),
    );

    expect(mocks.script[1].signOutCalls).toEqual([{ scope: "local" }]);
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
    expect(response.cookies.get(PREVIEW_COOKIE)?.maxAge).toBe(0);
  });

  it.each([
    ["an empty query", "/login?brand="],
    ["duplicate query values", "/login?brand=alpha-dog&brand=other"],
    ["an uppercase slug", "/login?brand=Alpha-Dog"],
    ["a malformed slug", "/login?brand=alpha--dog"],
    ["an overlong slug", `/login?brand=${"a".repeat(64)}`],
  ])(
    "fails closed for %s and does not fall back to the cookie",
    async (_, path) => {
      scriptClient(null);

      const response = await updateSession(
        makeRequest(path, {
          headers: { cookie: `${PREVIEW_COOKIE}=existing-partner` },
        }),
      );

      expect(mocks.clients).toHaveLength(1);
      expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
      expect(response.cookies.get(PREVIEW_COOKIE)?.maxAge).toBe(0);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
    },
  );

  it("clears an invalid preview cookie without consulting the admin channel", async () => {
    scriptClient(null);

    const response = await updateSession(
      makeRequest("/login", {
        headers: { cookie: `${PREVIEW_COOKIE}=alpha--dog` },
      }),
    );

    expect(mocks.clients).toHaveLength(1);
    expect(response.cookies.get(PREVIEW_COOKIE)?.maxAge).toBe(0);
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
  });

  it("clears duplicate preview cookies without consulting the admin channel", async () => {
    scriptClient(null);

    const response = await updateSession(
      makeRequest("/login", {
        headers: {
          cookie: `${PREVIEW_COOKIE}=alpha-dog; ${PREVIEW_COOKIE}=other-partner`,
        },
      }),
    );

    expect(mocks.clients).toHaveLength(1);
    expect(response.cookies.get(PREVIEW_COOKIE)?.maxAge).toBe(0);
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
  });

  it("lets a valid query replace an existing preview cookie", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });

    const response = await updateSession(
      makeRequest("/login?brand=alpha-dog", {
        headers: { cookie: `${PREVIEW_COOKIE}=other-partner` },
      }),
    );

    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBe("alpha-dog");
    expect(response.cookies.get(PREVIEW_COOKIE)?.value).toBe("alpha-dog");
  });

  it("passes a syntactically valid unknown slug to the branding resolver", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });

    const response = await updateSession(
      makeRequest("/login?brand=unknown-partner"),
    );

    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBe(
      "unknown-partner",
    );
  });

  it("keeps customer, admin, and preview cookie writes on one response", async () => {
    scriptClient(null, {
      rotateOnClaims: [
        { name: "sb-ref-auth-token", value: "customer-rotated", options: {} },
      ],
    });
    scriptClient(
      { id: ADMIN_ID },
      {
        rotateOnUser: [
          { name: "sa-admin-auth", value: "admin-rotated", options: {} },
        ],
      },
    );
    const request = makeRequest("/dashboard?brand=alpha-dog");

    const response = await updateSession(request);
    const names = response.cookies.getAll().map((cookie) => cookie.name);
    const downstreamCookie = response.headers.get(
      "x-middleware-request-cookie",
    );

    expect(names).toContain("sb-ref-auth-token");
    expect(names).toContain("sa-admin-auth");
    expect(names).toContain(PREVIEW_COOKIE);
    expect(downstreamCookie).toContain("sb-ref-auth-token=customer-rotated");
    expect(downstreamCookie).toContain("sa-admin-auth=admin-rotated");
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBe("alpha-dog");
  });

  it("uses one admin client when an admin page also requests preview", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });

    await updateSession(makeRequest("/admin?brand=alpha-dog"));

    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[1].getUser).toHaveBeenCalledOnce();
  });

  it("supports preview on HEAD page requests", async () => {
    scriptClient(null);
    scriptClient({ id: ADMIN_ID });

    const response = await updateSession(
      makeRequest("/login?brand=alpha-dog", { method: "HEAD" }),
    );

    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBe("alpha-dog");
  });

  it.each([
    ["POST pages", "POST", "/login?brand=alpha-dog"],
    ["API routes", "GET", "/api/health?brand=alpha-dog"],
    ["the public embed script", "GET", "/widget/embed.js?brand=alpha-dog"],
    ["booking alert navigation", "GET", "/booking-alerts/open/token?brand=alpha-dog"],
    ["booking alert carrier preview", "HEAD", "/booking-alerts/open/token?brand=alpha-dog"],
  ])("does not apply preview to %s", async (_, method, path) => {
    scriptClient(null);

    const response = await updateSession(
      makeRequest(path, {
        method,
        headers: {
          cookie: `${PREVIEW_COOKIE}=alpha-dog`,
          [PREVIEW_HEADER]: "forged-partner",
        },
      }),
    );

    expect(mocks.clients).toHaveLength(1);
    expect(response.headers.get(FORWARDED_PREVIEW_HEADER)).toBeNull();
    expect(response.cookies.get(PREVIEW_COOKIE)).toBeUndefined();
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
  });

  it("does not run the admin client for lookalike customer paths", async () => {
    scriptClient({ id: OTHER_ID });
    await updateSession(makeRequest("/administrators"));
    expect(mocks.clients).toHaveLength(1);
  });
});
