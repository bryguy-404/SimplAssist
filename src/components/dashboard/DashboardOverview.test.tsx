import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RequestBrand } from "@/lib/branding/types";

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateValues: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <Value,>(initialValue: Value) => {
      const index = mocks.stateIndex++;
      const value =
        index < mocks.stateValues.length
          ? (mocks.stateValues[index] as Value)
          : initialValue;
      return [value, vi.fn()] as const;
    },
  };
});

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

vi.mock("@/components/phone/PhoneNumberSelector", () => ({
  default: () => <div>Phone number selector</div>,
}));
vi.mock("@/components/dashboard/A2pStatusCard", () => ({
  default: () => null,
}));
vi.mock("@/components/dashboard/CallForwardingNudge", () => ({
  default: () => null,
}));

import { BrandProvider } from "@/components/branding/BrandProvider";
import DashboardOverview from "./DashboardOverview";

type DashboardHotLead = React.ComponentProps<
  typeof DashboardOverview
>["hotLeads"][number];

const DEFAULT_REQUEST_BRAND: RequestBrand = {
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

const PARTNER_REQUEST_BRAND: RequestBrand = {
  ...DEFAULT_REQUEST_BRAND,
  source: "partner_host",
  brand: {
    ...DEFAULT_REQUEST_BRAND.brand,
    kind: "partner",
    partnerId: "11111111-1111-4111-8111-111111111111",
    slug: "alpha-dog",
    name: "Alpha Dog Agency",
  },
};

const a2pStatus = {
  brandStatus: null,
  brandStatusUpdatedAt: null,
  brandRejectionReason: null,
  campaignStatus: null,
  campaignStatusUpdatedAt: null,
  campaignRejectionReason: null,
  assignmentStatus: null,
  assignmentFailureReason: null,
  smsReady: false,
  smsBlockReason: null,
} as const;

function renderOverview(args: {
  requestBrand: RequestBrand;
  phoneNumber: string | null;
  billingMode?: "stripe" | "invoiced" | "comped";
  isPartnerManagedBilling?: boolean;
  stateValues?: unknown[];
  totalContacts?: number;
  hotLeads?: DashboardHotLead[];
  smsEnabled?: boolean;
  messagesThisWeek?: number;
}): string {
  mocks.stateIndex = 0;
  mocks.stateValues = args.stateValues ?? [];

  return renderToStaticMarkup(
    <BrandProvider requestBrand={args.requestBrand}>
      <DashboardOverview
        stats={{
          totalConversations: 0,
          activeConversations: 0,
          totalContacts: args.totalContacts ?? args.hotLeads?.length ?? 0,
          messagesThisWeek: args.messagesThisWeek ?? 0,
        }}
        recentConversations={[]}
        hotLeads={args.hotLeads ?? []}
        phoneNumber={args.phoneNumber}
        a2pStatus={a2pStatus}
        showCallForwardingNudge={false}
        billingMode={args.billingMode ?? "stripe"}
        isPartnerManagedBilling={args.isPartnerManagedBilling}
        smsEnabled={args.smsEnabled}
      />
    </BrandProvider>
  );
}

describe("DashboardOverview hot-lead classification", () => {
  it("explains an empty authoritative-status result without score language", () => {
    const html = renderOverview({
      requestBrand: DEFAULT_REQUEST_BRAND,
      phoneNumber: null,
      totalContacts: 1,
    });

    expect(html).toContain(
      "No hot leads yet. Contacts classified as hot will appear here.",
    );
    expect(html).not.toContain("lead score of 7+");
  });

  it("renders a status-hot score-zero contact with a categorical Hot badge only", () => {
    const statusHotScoreZero = {
      id: "contact-hot",
      business_id: "business-1",
      name: "Status Hot Score Zero",
      phone_number: "+13175550101",
      email: null,
      session_id: null,
      source_channel: "sms",
      lead_score: 0,
      lead_status: "hot",
      lead_status_updated_at: "2026-08-11T15:00:00.000Z",
      notes: null,
      created_at: "2026-08-10T15:00:00.000Z",
      last_contacted_at: "2026-08-11T15:00:00.000Z",
    } satisfies DashboardHotLead;
    const html = renderOverview({
      requestBrand: DEFAULT_REQUEST_BRAND,
      phoneNumber: null,
      hotLeads: [statusHotScoreZero],
    });
    const hotLeadsSection = html.slice(
      html.indexOf("Hot Leads"),
      html.indexOf("Quick Actions"),
    );

    expect(hotLeadsSection).toContain("Status Hot Score Zero");
    expect(hotLeadsSection).toMatch(/Hot<\/span>/);
    expect(hotLeadsSection).not.toContain(">0</span>");
    expect(hotLeadsSection).not.toContain("Cold");
    expect(hotLeadsSection).not.toContain("Lead Score");
  });
});

describe("DashboardOverview outgoing-message metric", () => {
  it.each([true, false])("renders the outgoing count and rolling-week scope with SMS enabled=%s", (smsEnabled) => {
    const html = renderOverview({ requestBrand: DEFAULT_REQUEST_BRAND, phoneNumber: null,
      messagesThisWeek: 37, smsEnabled });
    expect(html).toContain("Messages Sent");
    expect(html).toContain("Last 7 days");
    expect(html).toMatch(/>37<\/p>/);
    expect(html).toContain("Outgoing SMS and website chat");
    expect(html).not.toContain("Web Messages");
  });
});

describe("DashboardOverview visible brand copy", () => {
  it("uses widget-first Chat Only copy without phone, carrier, or texting controls", () => {
    const html = renderOverview({
      requestBrand: DEFAULT_REQUEST_BRAND,
      phoneNumber: "+13175550123",
      smsEnabled: false,
      stateValues: [true, false],
    });

    expect(html).toContain("Messages Sent");
    expect(html).toContain("Install your website widget and start a test chat.");
    expect(html).toContain(
      "Manage your widget, AI answers, business details, hours, and calendar connection."
    );
    expect(html).not.toContain("Set Up Phone Number");
    expect(html).not.toContain("Your SimplAssist Number");
    expect(html).not.toContain("Customers can’t text");
    expect(html).not.toContain("Phone number selector");
  });

  it("preserves the default account name", () => {
    const html = renderOverview({
      requestBrand: DEFAULT_REQUEST_BRAND,
      phoneNumber: null,
    });

    expect(html).toContain("Your SimplAssist account");
  });

  it("uses the partner name in all three scoped dashboard references", () => {
    const missingNumberHtml = renderOverview({
      requestBrand: PARTNER_REQUEST_BRAND,
      phoneNumber: null,
    });
    const activeNumberHtml = renderOverview({
      requestBrand: PARTNER_REQUEST_BRAND,
      phoneNumber: "+13175550123",
    });
    const modalHtml = renderOverview({
      requestBrand: PARTNER_REQUEST_BRAND,
      phoneNumber: null,
      stateValues: [true, false],
    });

    expect(missingNumberHtml).toContain("Your Alpha Dog Agency account");
    expect(activeNumberHtml).toContain("Your Alpha Dog Agency Number");
    expect(modalHtml).toContain("set it up for Alpha Dog Agency.");
    expect(
      `${missingNumberHtml}${activeNumberHtml}${modalHtml}`
    ).not.toContain("SimplAssist");
  });
});

describe("DashboardOverview billing copy", () => {
  it("preserves the exact Billing link and subscription-management copy by default for direct Stripe billing", () => {
    const html = renderOverview({
      requestBrand: DEFAULT_REQUEST_BRAND,
      phoneNumber: null,
      billingMode: "stripe",
    });

    expect(html.match(/href="\/billing"/g)).toHaveLength(1);
    expect(html).toContain(">Billing</h4>");
    expect(html).toContain(
      "Manage your plan, payment method, and subscription details."
    );
    expect(html).not.toContain("partner-managed billing");
  });

  it.each(["invoiced", "comped"] as const)(
    "preserves the exact Billing link and existing copy for direct %s billing",
    (billingMode) => {
      const html = renderOverview({
        requestBrand: DEFAULT_REQUEST_BRAND,
        phoneNumber: null,
        billingMode,
        isPartnerManagedBilling: false,
      });

      expect(html.match(/href="\/billing"/g)).toHaveLength(1);
      expect(html).toContain(">Billing</h4>");
      expect(html).toContain("View your partner-managed billing details");
      expect(html).not.toContain(
        "Manage your plan, payment method, and subscription details."
      );
    }
  );

  it.each(["stripe", "invoiced", "comped"] as const)(
    "hides the whole Billing quick action for partner-managed %s billing",
    (billingMode) => {
      const html = renderOverview({
        requestBrand: PARTNER_REQUEST_BRAND,
        phoneNumber: null,
        billingMode,
        isPartnerManagedBilling: true,
      });

      expect(html).toContain('href="/conversations"');
      expect(html).toContain('href="/settings"');
      expect(html).not.toContain('href="/billing"');
      expect(html).not.toContain(">Billing</h4>");
      expect(html).not.toContain(
        "Manage your plan, payment method, and subscription details."
      );
      expect(html).not.toContain("View your partner-managed billing details");
    }
  );
});
