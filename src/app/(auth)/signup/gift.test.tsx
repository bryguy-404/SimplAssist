import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/components/branding/BrandProvider";
import type { RequestBrand } from "@/lib/branding/types";

const mocks = vi.hoisted(() => ({
  cookie: null as string | null,
  resolveStrictAuthCallbackOrigin: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: () =>
    new Headers({
      host: "simplassist.com",
      ...(mocks.cookie ? { cookie: mocks.cookie } : {}),
    }),
}));
vi.mock("@/lib/auth/callbackOrigin.server", () => ({
  resolveStrictAuthCallbackOrigin: mocks.resolveStrictAuthCallbackOrigin,
}));
vi.mock("@/lib/branding/requestBrand.server", () => ({ getRequestBrand: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserClient: () => ({ auth: { signUp: mocks.signUp } }),
}));

import SignupPage from "./page";

const REQUEST_BRAND: RequestBrand = {
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

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(
    <BrandProvider requestBrand={REQUEST_BRAND}>{await SignupPage()}</BrandProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookie = null;
  mocks.resolveStrictAuthCallbackOrigin.mockResolvedValue({
    origin: "https://simplassist.com",
    kind: "direct",
    partnerId: null,
  });
});

describe("signup with a carried gift code", () => {
  it("tells the visitor their code is saved and will be applied at checkout", async () => {
    mocks.cookie = "theme=dark; sa_gift_code=ROSA-FREEMONTH";

    const html = await renderPage();

    expect(html).toContain("ROSA-FREEMONTH");
    expect(html).toContain("It will be applied for you at checkout.");
    expect(html).toContain("Create your account");
  });

  it.each([null, "theme=dark", "sa_gift_code=%3Cscript%3E"])(
    "is the ordinary signup page without a usable code (%j)",
    async (cookie) => {
      mocks.cookie = cookie;

      const html = await renderPage();

      expect(html).toContain("Create your account");
      expect(html).not.toContain("applied for you at checkout");
      expect(html).not.toContain("script");
    },
  );

  it("never shows a code on a partner domain, which has no public signup", async () => {
    mocks.cookie = "sa_gift_code=ROSA-FREEMONTH";
    mocks.resolveStrictAuthCallbackOrigin.mockResolvedValue({
      origin: "https://app.partner.example",
      kind: "partner",
      partnerId: "11111111-1111-4111-8111-111111111111",
    });

    const html = await renderPage();

    expect(html).toContain("Account creation is by invitation");
    expect(html).not.toContain("ROSA-FREEMONTH");
  });
});
