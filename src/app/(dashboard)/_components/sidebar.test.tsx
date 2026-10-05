import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestBrand } from "@/lib/branding/types";
import type { PrimaryGoal } from "@/types/database";

const mocks = vi.hoisted(() => ({
  pathname: "/dashboard",
  push: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({
    push: mocks.push,
    refresh: mocks.refresh,
  }),
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

vi.mock("next/image", () => ({
  default: ({
    alt,
    priority,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    void priority;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img alt={alt} {...props} />
    );
  },
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserClient: () => ({
    auth: {
      signOut: mocks.signOut,
    },
  }),
}));

vi.mock("@/lib/theme-v2/ui", () => ({
  ThemeToggleV2: () => <button type="button">Theme</button>,
}));

vi.mock("@/components/icons/staggered-menu-icon", () => ({
  StaggeredMenuIcon: () => <span>Menu icon</span>,
}));

import Sidebar from "./sidebar";
import { BrandProvider } from "@/components/branding/BrandProvider";

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

function renderSidebar(props?: {
  activePath?: string;
  primaryGoal?: PrimaryGoal | null;
  canUseCalendar?: boolean;
  canUseWidget?: boolean;
  isPartnerManagedBilling?: boolean;
  requestBrand?: RequestBrand;
}) {
  const { requestBrand = DEFAULT_REQUEST, ...sidebarProps } = props ?? {};
  return renderToStaticMarkup(
    <BrandProvider requestBrand={requestBrand}>
      <Sidebar
        userEmail="owner@example.com"
        websiteUrl={null}
        {...sidebarProps}
      />
    </BrandProvider>
  );
}

function renderedNavSections(markup: string): string[] {
  return Array.from(markup.matchAll(/<nav\b[^>]*>(.*?)<\/nav>/g), (match) => match[1]);
}

function renderedNavHrefs(nav: string): string[] {
  return Array.from(nav.matchAll(/<a href="([^"]+)"/g), (match) => match[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/dashboard";
});

describe("Sidebar navigation", () => {
  it("hides the closed mobile panel from keyboard focus and assistive technology", () => {
    const markup = renderSidebar();
    const mobile = markup.match(/<aside id="mobile-dashboard-navigation"[^>]*>/)?.[0];
    expect(mobile).toContain('aria-hidden="true"');
    expect(mobile).toContain("invisible pointer-events-none");
    expect(markup).toContain('aria-controls="mobile-dashboard-navigation"');
  });
  it.each([null, "book", "quote", "callback"] as const)(
    "keeps primary_goal=%s byte-identical to the default legacy navigation",
    (primaryGoal) => {
      expect(renderSidebar({ primaryGoal })).toBe(renderSidebar());
    },
  );

  it("replaces only the Calendar slot with Leads for signup businesses", () => {
    const legacyNavSections = renderedNavSections(renderSidebar());
    const signupNavSections = renderedNavSections(
      renderSidebar({ primaryGoal: "signup" }),
    );

    expect(signupNavSections).toHaveLength(legacyNavSections.length);
    signupNavSections.forEach((nav, index) => {
      expect(renderedNavHrefs(nav)).toEqual(
        renderedNavHrefs(legacyNavSections[index]).map((href) =>
          href === "/calendar" ? "/leads" : href,
        ),
      );
      expect(nav).toContain('href="/leads"');
      expect(nav).toContain(">Leads</span>");
      expect(nav).not.toContain('href="/calendar"');
      expect(nav).not.toContain(">Calendar</span>");
    });
  });

  it("does not apply the Calendar entitlement lock to the signup Leads slot", () => {
    const markup = renderSidebar({
      primaryGoal: "signup",
      canUseCalendar: false,
    });

    expect(markup).not.toContain(
      'aria-label="Calendar is unavailable on the current subscription"',
    );
    expect(markup).not.toContain(
      'aria-label="Leads is unavailable on the current subscription"',
    );
  });

  it("marks Leads active through the standard pathname match", () => {
    mocks.pathname = "/leads";

    const navSections = renderedNavSections(
      renderSidebar({ primaryGoal: "signup" }),
    );

    for (const nav of navSections) {
      const leadsLink = nav.match(/<a href="\/leads" class="([^"]+)"/);

      expect(leadsLink?.[1]).toContain("bg-[var(--brand-accent-soft)]");
    }
  });

  it.each([
    ["the default", undefined],
    ["an explicit direct-business setting", false],
  ] as const)("shows Billing exactly once in each nav for %s", (_scenario, isPartnerManagedBilling) => {
    const navSections = renderedNavSections(
      renderSidebar({ isPartnerManagedBilling }),
    );

    expect(navSections).toHaveLength(2);
    for (const nav of navSections) {
      expect(nav.match(/href="\/billing"/g)).toHaveLength(1);
      expect(nav).toContain(">Billing</span>");
    }
  });

  it("removes only Billing from both partner-managed navs", () => {
    const directNavSections = renderedNavSections(renderSidebar());
    const partnerNavSections = renderedNavSections(
      renderSidebar({ isPartnerManagedBilling: true }),
    );

    expect(directNavSections).toHaveLength(2);
    expect(partnerNavSections).toHaveLength(2);
    partnerNavSections.forEach((nav, index) => {
      expect(nav).not.toContain('href="/billing"');
      expect(nav).not.toContain(">Billing</span>");
      expect(renderedNavHrefs(nav)).toEqual(
        renderedNavHrefs(directNavSections[index]).filter(
          (href) => href !== "/billing",
        ),
      );
    });
  });

  it("shows Knowledge Gaps between Conversations and Contacts", () => {
    const navSections = renderedNavSections(renderSidebar());

    expect(navSections).toHaveLength(2);
    for (const nav of navSections) {
      const conversationsIndex = nav.indexOf('href="/conversations"');
      const knowledgeGapsIndex = nav.indexOf('href="/knowledge-gaps"');
      const contactsIndex = nav.indexOf('href="/contacts"');

      expect(conversationsIndex).toBeGreaterThanOrEqual(0);
      expect(knowledgeGapsIndex).toBeGreaterThan(conversationsIndex);
      expect(contactsIndex).toBeGreaterThan(knowledgeGapsIndex);
      expect(nav).toContain(">Knowledge Gaps</span>");
    }
  });

  it("keeps Knowledge Gaps unlocked when gated features are unavailable", () => {
    const markup = renderSidebar({
      canUseCalendar: false,
      canUseWidget: false,
    });

    expect(markup).toContain(
      'aria-label="Calendar is unavailable on the current subscription"'
    );
    expect(markup).toContain(
      'aria-label="Widget is unavailable on the current subscription"'
    );
    expect(markup).not.toContain(
      'aria-label="Knowledge Gaps is unavailable on the current subscription"'
    );
  });

  it("marks Knowledge Gaps active through the standard pathname match", () => {
    mocks.pathname = "/knowledge-gaps";

    const navSections = renderedNavSections(renderSidebar());

    for (const nav of navSections) {
      const knowledgeGapsLink = nav.match(
        /<a href="\/knowledge-gaps" class="([^"]+)"/
      );

      expect(knowledgeGapsLink?.[1]).toContain(
        "bg-[var(--brand-accent-soft)]"
      );
    }
  });

  it("keeps Settings active on nested Assistant Knowledge pages", () => {
    mocks.pathname = "/settings/knowledge";

    const navSections = renderedNavSections(renderSidebar());
    for (const nav of navSections) {
      const settingsLink = nav.match(/<a href="\/settings" class="([^"]+)"/);
      expect(settingsLink?.[1]).toContain("bg-[var(--brand-accent-soft)]");
    }
  });

  it("uses the partner identity for desktop and mobile logos", () => {
    const markup = renderSidebar({
      requestBrand: {
        ...DEFAULT_REQUEST,
        source: "partner_host",
        brand: {
          ...DEFAULT_REQUEST.brand,
          kind: "partner",
          partnerId: "11111111-1111-4111-8111-111111111111",
          slug: "alpha-dog",
          name: "Alpha Dog Agency",
          publicOrigin: "https://app.partner.example",
          logoLightUrl: "https://cdn.partner.example/logo.png",
          logoDarkUrl: null,
          faviconUrl: null,
        },
      },
    });

    expect(markup).toContain('src="https://cdn.partner.example/logo.png"');
    expect(markup).toContain('alt="Alpha Dog Agency"');
    expect(markup).not.toContain("/logo-light.png");
    expect(markup).not.toContain("/logo-dark.png");
  });
});
