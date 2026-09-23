import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/components/branding/BrandProvider";
import type { RequestBrand } from "@/lib/branding/types";
import DirectPlanSelection, {
  reconcileDirectPlanSelection,
} from "./DirectPlanSelection";

vi.mock("@/components/waitlist/FullSuiteWaitlistButton", () => ({
  FullSuiteWaitlistButton: () => <button>Notify Me When It Launches</button>,
}));

const PARTNER_BRAND: RequestBrand = {
  source: "partner_host",
  isPreview: false,
  brand: {
    kind: "partner",
    partnerId: "11111111-1111-4111-8111-111111111111",
    slug: "alpha-dog",
    name: "Alpha Dog Agency",
    publicOrigin: "https://alpha-dog.example.test",
    logoLightUrl: null,
    logoDarkUrl: null,
    faviconUrl: null,
    colors: {
      primary: "#123456",
      primaryHover: "#123457",
      primaryActive: "#123458",
      accent: "#123459",
      primaryDark: "#abcdef",
      primaryHoverDark: "#abcdee",
      primaryActiveDark: "#abcded",
      accentDark: "#abcdec",
    },
  },
};

function renderSelection(args: {
  initialPlan: "chat_only" | "sms_only" | "sms_and_chat" | "full" | null;
  chatOnlyAvailable: boolean;
  onBack?: () => void;
}) {
  return renderToStaticMarkup(
    <BrandProvider requestBrand={PARTNER_BRAND}>
      <DirectPlanSelection
        {...args}
        onNext={vi.fn()}
      />
    </BrandProvider>,
  );
}

function radio(markup: string, value: string): string | undefined {
  return (markup.match(/<input\b[^>]*>/g) ?? []).find((input) =>
    input.includes(`value="${value}"`),
  );
}

describe("DirectPlanSelection", () => {
  it("renders enabled Chat Only beside existing plans with partner copy and no setup fee", () => {
    const markup = renderSelection({
      initialPlan: "chat_only",
      chatOnlyAvailable: true,
    });

    expect(markup).toContain("Choose your Alpha Dog Agency plan");
    expect(markup).toContain("Chat Only");
    expect(markup).toContain("Starter / SMS Only");
    expect(markup).toContain("Growth / SMS + Web Chat");
    expect(markup).toContain("Pro / Full Suite");
    expect(markup).not.toContain("SimplAssist");
    expect(markup).toContain("$10 at checkout");
    expect(markup).toContain("Choose your plan now. Payment comes after you finish setup.");
    expect(markup).not.toContain("today");
    expect(markup).toContain("200 AI replies/month");
    expect(markup).toContain("No setup or SMS activation fee");
    expect(radio(markup, "chat_only")).toContain('checked=""');
  });

  it("keeps an unavailable saved Chat Only choice from silently becoming a texting choice", () => {
    const markup = renderSelection({
      initialPlan: "chat_only",
      chatOnlyAvailable: false,
    });

    expect(radio(markup, "chat_only")).toBeUndefined();
    expect(markup).not.toContain("No setup or SMS activation fee");
    expect(markup).not.toContain('checked=""');
    expect(markup).toContain("Your saved plan is temporarily unavailable.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Continue setup<\/button>/);
  });

  it("requires deliberate selection while keeping Growth recommended", () => {
    const markup = renderSelection({
      initialPlan: null,
      chatOnlyAvailable: true,
    });

    expect(markup).not.toContain('checked=""');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Continue setup<\/button>/);
    expect(markup).toContain("Recommended");
    expect(markup).not.toContain(">Back<");
    expect(markup).not.toContain("one-time setup and SMS activation fee");
  });

  it.each(["chat_only", "sms_only", "sms_and_chat", "full"] as const)(
    "restores the saved available %s selection on return",
    (initialPlan) => {
      const markup = renderSelection({ initialPlan, chatOnlyAvailable: true });
      expect(radio(markup, initialPlan)).toContain('checked=""');
      expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Continue setup<\/button>/);
    },
  );

  it("keeps Back available for the legacy selector", () => {
    expect(renderSelection({
      initialPlan: "sms_only",
      chatOnlyAvailable: false,
      onBack: vi.fn(),
    })).toContain(">Back<");
  });

  it("clears a mounted unavailable selection without choosing a different plan", () => {
    expect(
      reconcileDirectPlanSelection({
        currentPlan: "chat_only",
        initialPlan: "chat_only",
        selectablePlans: ["sms_only", "sms_and_chat", "full"],
      }),
    ).toBeNull();
  });

  it("preserves an explicit local selection when no saved plan exists", () => {
    expect(reconcileDirectPlanSelection({
      currentPlan: "sms_only",
      initialPlan: null,
      selectablePlans: ["chat_only", "sms_only", "sms_and_chat", "full"],
    })).toBe("sms_only");
  });
});
