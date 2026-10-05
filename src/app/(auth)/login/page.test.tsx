import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/components/branding/BrandProvider";
import type { RequestBrand } from "@/lib/branding/types";

const mocks = vi.hoisted(() => ({
  createBrowserClient: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  signInWithPassword: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }),
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({
  createBrowserClient: mocks.createBrowserClient,
}));

import LoginPage from "./page";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createBrowserClient.mockReturnValue({
    auth: { signInWithPassword: mocks.signInWithPassword },
  });
});

function renderPage(requestBrand: RequestBrand): string {
  return renderToStaticMarkup(
    <BrandProvider requestBrand={requestBrand}>
      <LoginPage />
    </BrandProvider>,
  );
}

describe("LoginPage recovery navigation", () => {
  it("keeps credentials out of native GET URLs before hydration", () => {
    const html = renderPage(DEFAULT_REQUEST);
    expect(html.match(/<form\b[^>]*>/)?.[0]).toContain('method="post"');
    expect(html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("offers one same-domain forgot-password link beside the password flow", () => {
    const html = renderPage(DEFAULT_REQUEST);

    expect(html).toContain("Forgot password?");
    expect(html.match(/href="\/forgot-password"/g)).toHaveLength(1);
    expect(html).not.toContain("simplassist.com/forgot-password");
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain("Sign in");
  });
});

describe("LoginPage signup navigation", () => {
  it.each([
    ["the default brand", DEFAULT_REQUEST],
    ["an authorized partner preview", PREVIEW_REQUEST],
  ])("offers public signup for %s", (_, requestBrand) => {
    const html = renderPage(requestBrand);

    expect(html).toContain("Don&#x27;t have an account?");
    expect(html).toContain('href="/signup"');
    expect(html).toContain("Create one");
  });

  it("does not offer public signup on an actual partner host", () => {
    const html = renderPage(PARTNER_REQUEST);

    expect(html).not.toContain("Don&#x27;t have an account?");
    expect(html).not.toContain('href="/signup"');
    expect(html).not.toContain("Create one");
  });
});
