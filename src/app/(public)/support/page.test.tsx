import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/components/branding/BrandProvider";
import type { RequestBrand } from "@/lib/branding/types";

const mocks = vi.hoisted(() => ({
  getRequestBrand: vi.fn(),
  getOptionalWorkspaceRouteAccess: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/branding/requestBrand.server", () => ({
  getRequestBrand: mocks.getRequestBrand,
}));

vi.mock("@/lib/branding/defaultBrand", () => ({
  getCanonicalAppOrigin: () =>
    process.env.NEXT_PUBLIC_APP_URL ?? "https://simplassist.com",
}));

vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  getOptionalWorkspaceRouteAccess: mocks.getOptionalWorkspaceRouteAccess,
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import SupportPage, { generateMetadata } from "./page";

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
  source: "partner_host",
  isPreview: false,
  brand: {
    ...DEFAULT_REQUEST.brand,
    kind: "partner",
    partnerId: "11111111-1111-4111-8111-111111111111",
    slug: "alpha-dog",
    name: "Alpha Dog Agency",
    publicOrigin: "https://app.alphadogagency.ai",
    logoLightUrl: "https://assets.alphadogagency.ai/logo-light.png",
    logoDarkUrl: "https://assets.alphadogagency.ai/logo-dark.png",
  },
};

function mockBusinessLookup(
  data: { id: string; name: string | null } | null,
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  mocks.from.mockReturnValue({ select });
  return { select, eq, maybeSingle };
}

async function renderPage(requestBrand: RequestBrand): Promise<string> {
  mocks.getRequestBrand.mockResolvedValue(requestBrand);
  const page = await SupportPage({ searchParams: {} });

  return renderToStaticMarkup(
    <BrandProvider requestBrand={requestBrand}>{page}</BrandProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com");
  mocks.getOptionalWorkspaceRouteAccess.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("support metadata", () => {
  it("preserves the default SimplAssist identity", async () => {
    mocks.getRequestBrand.mockResolvedValue(DEFAULT_REQUEST);

    await expect(generateMetadata()).resolves.toEqual({
      title: "Support — SimplAssist",
      description:
        "Get help with billing, phone number registration, or anything else.",
    });
  });

  it("uses the request partner identity", async () => {
    mocks.getRequestBrand.mockResolvedValue(PARTNER_REQUEST);

    await expect(generateMetadata()).resolves.toMatchObject({
      title: "Support — Alpha Dog Agency",
    });
  });
});

describe("SupportPage branding", () => {
  it("preserves SimplAssist logo, footer, and direct support email by default", async () => {
    const html = await renderPage(DEFAULT_REQUEST);

    expect(html).toContain("Contact support");
    expect(html).toContain("Send message");
    expect(html).toContain('alt="SimplAssist"');
    expect(html).toContain("support@simplassist.com");
    expect(html).not.toContain("bryan@simplassist.com");
    expect(html).toContain("SimplAssist, a product of Arambula Ventures LLC.");
    expect(html).toContain('href="https://simplassist.com/privacy"');
    expect(html).toContain('href="https://simplassist.com/terms"');
  });

  it("uses partner logos and footer without exposing the SimplAssist email or name", async () => {
    const html = await renderPage(PARTNER_REQUEST);

    expect(html).toContain('alt="Alpha Dog Agency"');
    expect(html).toContain(
      'src="https://assets.alphadogagency.ai/logo-light.png"',
    );
    expect(html).toContain("Alpha Dog Agency.");
    expect(html).not.toContain("support@simplassist.com");
    expect(html).not.toContain("SimplAssist");
    expect(html).toContain("Send message");
    expect(html).toContain('href="https://simplassist.com/privacy"');
    expect(html).toContain('href="https://simplassist.com/terms"');
    expect(html).not.toContain('href="https://app.alphadogagency.ai/privacy"');
  });

  it("shows account linkage only for a workspace authorized on this host", async () => {
    const businessId = "22222222-2222-4222-8222-222222222222";
    mocks.getOptionalWorkspaceRouteAccess.mockResolvedValue({
      status: "resolved",
      hostKind: "canonical",
      user: {
        id: "33333333-3333-4333-8333-333333333333",
        email: "owner@example.com",
        user_metadata: { full_name: "Owner Name" },
      },
      business: { id: businessId, partner_id: null },
    });
    const lookup = mockBusinessLookup({ id: businessId, name: "Acme Dental" });

    const html = await renderPage(DEFAULT_REQUEST);

    expect(html).toContain("Signed in");
    expect(html).toContain("Acme Dental");
    expect(lookup.eq).toHaveBeenCalledWith("id", businessId);
  });

  it("treats a mismatched or unavailable session as anonymous", async () => {
    mocks.getOptionalWorkspaceRouteAccess.mockResolvedValue(null);

    const html = await renderPage(PARTNER_REQUEST);

    expect(html).not.toContain("Signed in");
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
