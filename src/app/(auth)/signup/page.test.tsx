import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/components/branding/BrandProvider";
import type { RequestBrand } from "@/lib/branding/types";
import { SignupConfirmation } from "./SignupConfirmation";

const mocks = vi.hoisted(() => ({
  createBrowserClient: vi.fn(),
  currentHost: "simplassist.com",
  getRequestBrand: vi.fn(),
  resolveStrictAuthCallbackOrigin: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: () => new Headers({ host: mocks.currentHost }),
}));
vi.mock("@/lib/auth/callbackOrigin.server", () => ({
  resolveStrictAuthCallbackOrigin: mocks.resolveStrictAuthCallbackOrigin,
}));
vi.mock("@/lib/branding/requestBrand.server", () => ({
  getRequestBrand: mocks.getRequestBrand,
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserClient: mocks.createBrowserClient,
}));

import SignupPage from "./page";

const DEFAULT_REQUEST: RequestBrand = {
  source: "default",
  isPreview: false,
  brand: {
    kind: "default",
    partnerId: null,
    slug: null,
    name: "SimplAssist",
    publicOrigin: "https://simplassist.com",
    logoLightUrl: "/logo-light.png",
    logoDarkUrl: "/logo-dark.png",
    faviconUrl: "/favicon-2.png",
    colors: {
      primary: "#ea580c",
      primaryHover: "#c2410c",
      primaryActive: "#9a3412",
      accent: "#c2410c",
      primaryDark: "#ff914d",
      primaryHoverDark: "#f57f33",
      primaryActiveDark: "#e8752c",
      accentDark: "#ff914d",
    },
  },
};

const PARTNER_REQUEST: RequestBrand = {
  ...DEFAULT_REQUEST,
  source: "partner_host",
  brand: {
    ...DEFAULT_REQUEST.brand,
    kind: "partner",
    partnerId: "11111111-1111-4111-8111-111111111111",
    slug: "alpha-dog",
    name: "Alpha Dog Agency",
    publicOrigin: "https://app.alphadogagency.ai",
  },
};

const PREVIEW_REQUEST: RequestBrand = {
  ...PARTNER_REQUEST,
  source: "admin_preview",
  isPreview: true,
};

const DIRECT_IDENTITY = {
  origin: "https://simplassist.com",
  kind: "direct" as const,
  partnerId: null,
};

const PARTNER_IDENTITY = {
  origin: "https://app.alphadogagency.ai",
  kind: "partner" as const,
  partnerId: "11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentHost = "simplassist.com";
  mocks.createBrowserClient.mockReturnValue({
    auth: { signUp: mocks.signUp },
  });
  mocks.getRequestBrand.mockResolvedValue(DEFAULT_REQUEST);
  mocks.resolveStrictAuthCallbackOrigin.mockResolvedValue(DIRECT_IDENTITY);
});

function renderConfirmation(requestBrand: RequestBrand): string {
  return renderToStaticMarkup(
    <BrandProvider requestBrand={requestBrand}>
      <SignupConfirmation icon={null} onGoBack={vi.fn()} />
    </BrandProvider>,
  );
}

async function renderPage(
  requestBrand: RequestBrand = DEFAULT_REQUEST,
): Promise<string> {
  return renderToStaticMarkup(
    <BrandProvider requestBrand={requestBrand}>
      {await SignupPage()}
    </BrandProvider>,
  );
}

function expectInvitationOnly(html: string): void {
  expect(html).toContain("Account creation is by invitation");
  expect(html).toContain("Contact your provider to request access.");
  expect(html).toContain("Already have access?");
  expect(html).toContain('href="/login"');
  expect(html).not.toContain("<form");
  expect(html).not.toContain('type="email"');
  expect(html).not.toContain("Create account");
  expect(mocks.createBrowserClient).not.toHaveBeenCalled();
  expect(mocks.signUp).not.toHaveBeenCalled();
}

describe("SignupPage strict host policy", () => {
  it("keeps signup credentials out of native GET URLs before hydration", async () => {
    const html = await renderPage();
    expect(html.match(/<form\b[^>]*>/)?.[0]).toContain('method="post"');
    expect(html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it("keeps the canonical public signup form", async () => {
    const html = await renderPage();

    expect(mocks.resolveStrictAuthCallbackOrigin).toHaveBeenCalledWith(
      "simplassist.com",
    );
    expect(html).toContain("Create your account");
    expect(html).toContain("<form");
    expect(html).toContain('type="email"');
    expect(html).toContain("Create account");
    expect(html).not.toContain("Account creation is by invitation");
    expect(mocks.createBrowserClient).toHaveBeenCalledOnce();
    expect(mocks.getRequestBrand).not.toHaveBeenCalled();
  });

  it("keeps canonical signup enabled during an authorized partner preview", async () => {
    const html = await renderPage(PREVIEW_REQUEST);

    expect(html).toContain("Create your account");
    expect(html).toContain("<form");
    expect(html).not.toContain("Account creation is by invitation");
    expect(mocks.createBrowserClient).toHaveBeenCalledOnce();
    expect(mocks.getRequestBrand).not.toHaveBeenCalled();
  });

  it("replaces partner-host signup with branded invitation-only access", async () => {
    mocks.currentHost = "app.alphadogagency.ai";
    mocks.resolveStrictAuthCallbackOrigin.mockResolvedValueOnce(
      PARTNER_IDENTITY,
    );
    mocks.getRequestBrand.mockResolvedValueOnce(PARTNER_REQUEST);

    const html = await renderPage();

    expect(mocks.resolveStrictAuthCallbackOrigin).toHaveBeenCalledWith(
      "app.alphadogagency.ai",
    );
    expectInvitationOnly(html);
    expect(html).toContain("Log in to Alpha Dog Agency");
    expect(html).not.toContain("SimplAssist");
    expect(mocks.getRequestBrand).toHaveBeenCalledOnce();
  });

  it("keeps partner-host signup closed with generic login copy when branding is unavailable", async () => {
    mocks.currentHost = "app.alphadogagency.ai";
    mocks.resolveStrictAuthCallbackOrigin.mockResolvedValueOnce(
      PARTNER_IDENTITY,
    );
    mocks.getRequestBrand.mockRejectedValueOnce(new Error("branding failed"));

    const html = await renderPage();

    expectInvitationOnly(html);
    expect(html).toContain(">Log in</a>");
    expect(html).not.toContain("Log in to");
    expect(mocks.getRequestBrand).toHaveBeenCalledOnce();
  });

  it("does not use branding that does not match the strict partner identity", async () => {
    mocks.currentHost = "app.alphadogagency.ai";
    mocks.resolveStrictAuthCallbackOrigin.mockResolvedValueOnce(
      PARTNER_IDENTITY,
    );
    mocks.getRequestBrand.mockResolvedValueOnce(DEFAULT_REQUEST);

    const html = await renderPage();

    expectInvitationOnly(html);
    expect(html).toContain(">Log in</a>");
    expect(html).not.toContain("Log in to");
    expect(mocks.getRequestBrand).toHaveBeenCalledOnce();
  });

  it("fails closed with generic invitation copy for an unknown host", async () => {
    mocks.currentHost = "unknown.example.com";
    mocks.resolveStrictAuthCallbackOrigin.mockResolvedValueOnce(null);

    const html = await renderPage();

    expect(mocks.resolveStrictAuthCallbackOrigin).toHaveBeenCalledWith(
      "unknown.example.com",
    );
    expectInvitationOnly(html);
    expect(html).toContain(">Log in</a>");
    expect(html).not.toContain("Log in to");
    expect(mocks.getRequestBrand).not.toHaveBeenCalled();
  });

  it("fails closed with generic invitation copy when resolution throws", async () => {
    mocks.currentHost = "app.alphadogagency.ai";
    mocks.resolveStrictAuthCallbackOrigin.mockRejectedValueOnce(
      new Error("lookup failed"),
    );

    const html = await renderPage();

    expectInvitationOnly(html);
    expect(html).toContain(">Log in</a>");
    expect(html).not.toContain("Log in to");
    expect(mocks.getRequestBrand).not.toHaveBeenCalled();
  });

  it("keeps local development signup when localhost resolves as direct", async () => {
    mocks.currentHost = "localhost:3000";
    mocks.resolveStrictAuthCallbackOrigin.mockResolvedValueOnce({
      ...DIRECT_IDENTITY,
      origin: "http://localhost:3000",
    });

    const html = await renderPage();

    expect(mocks.resolveStrictAuthCallbackOrigin).toHaveBeenCalledWith(
      "localhost:3000",
    );
    expect(html).toContain("Create your account");
    expect(html).toContain("<form");
    expect(html).not.toContain("Account creation is by invitation");
    expect(mocks.createBrowserClient).toHaveBeenCalledOnce();
    expect(mocks.getRequestBrand).not.toHaveBeenCalled();
  });
});

describe("SignupConfirmation identity", () => {
  it("preserves the SimplAssist confirmation copy by default", () => {
    expect(renderConfirmation(DEFAULT_REQUEST)).toContain(
      "start using SimplAssist.",
    );
  });

  it("uses the partner name without leaking SimplAssist", () => {
    const html = renderConfirmation(PARTNER_REQUEST);

    expect(html).toContain("start using Alpha Dog Agency.");
    expect(html).not.toContain("SimplAssist");
  });
});
