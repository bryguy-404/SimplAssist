import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isChatOnlyPublicLaunchEnabled: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not_found");
  }),
}));
vi.mock("@/lib/billing/chatOnlyPublicLaunch.server", () => ({
  isChatOnlyPublicLaunchEnabled: mocks.isChatOnlyPublicLaunchEnabled,
}));

import HomeV2Page, { dynamic, revalidate } from "./page";
import { chatOnlyPlan, plans, plansForPublicLaunch } from "./content";

function visibleText(html: string): string {
  return html
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x27|39);/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function pricingSection(): string {
  const html = renderToStaticMarkup(<HomeV2Page />);
  const pricing = html.match(/<section id="pricing"[\s\S]*?<\/section>/)?.[0];
  expect(pricing).toBeDefined();
  return pricing ?? "";
}

beforeEach(() => {
  mocks.isChatOnlyPublicLaunchEnabled.mockReset();
  mocks.isChatOnlyPublicLaunchEnabled.mockReturnValue(false);
});

describe("home-v2 Chat Only public-launch composition", () => {
  it("resolves launch presentation at request time instead of caching a rollout value", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
  });

  it("preserves the original plan list when public launch is disabled", () => {
    expect(plansForPublicLaunch(false)).toBe(plans);
    expect(plans.map((plan) => plan.name)).toEqual([
      "SMS + Web Chat",
      "Full Suite",
    ]);
  });

  it("prepends the exact approved Chat Only offer without mutating existing plans", () => {
    expect(plansForPublicLaunch(true)).toEqual([chatOnlyPlan, ...plans]);
    expect(chatOnlyPlan).toEqual({
      name: "Chat Only",
      price: "$10",
      description:
        "An AI website receptionist for teams that want web chat without texting.",
      features: [
        "Website chat widget",
        "200 completed AI replies/month",
        "Web-chat lead capture",
        "Contact and conversation inbox",
        "AI answer, tone, FAQ, and service customization",
        "Google Calendar connection",
        "AI appointment scheduling",
        "No phone number, SMS, MMS, or Telnyx activation",
        "No setup or SMS activation fee",
      ],
      highlighted: false,
    });
    expect(plans.filter((plan) => plan.highlighted).map((plan) => plan.name)).toEqual([
      "SMS + Web Chat",
    ]);
  });

  it("renders the exact legacy three-plan pricing section while broad launch is off", () => {
    const pricing = pricingSection();
    const text = visibleText(pricing);

    expect(mocks.isChatOnlyPublicLaunchEnabled).toHaveBeenCalledOnce();
    expect(text).not.toContain("Chat Only");
    expect(text).toContain(
      "No contracts. Paid SMS activation includes a one-time $25 setup fee.",
    );
    expect(pricing).toContain("md:grid-cols-2");
    expect(pricing).not.toContain("lg:grid-cols-3");
    for (const plan of plans) expect(text).toContain(plan.name);
  });

  it("renders Chat Only only when the canonical server policy authorizes public launch", () => {
    mocks.isChatOnlyPublicLaunchEnabled.mockReturnValue(true);

    const pricing = pricingSection();
    const text = visibleText(pricing);

    expect(text).toContain("Chat Only");
    expect(text).toContain("$10 /mo");
    expect(text).toContain("200 completed AI replies/month");
    expect(text).toContain("No phone number, SMS, MMS, or Telnyx activation");
    expect(text).toContain("No setup or SMS activation fee");
    expect(text).toContain(
      "No contracts. Chat Only has no setup fee; paid SMS activation includes a one-time $25 setup fee.",
    );
    expect(pricing).toContain("lg:grid-cols-3");
    expect(pricing).not.toContain("md:grid-cols-2");
    expect(text.match(/Most Popular/g)).toHaveLength(1);
    for (const plan of plans) expect(text).toContain(plan.name);
  });
});
