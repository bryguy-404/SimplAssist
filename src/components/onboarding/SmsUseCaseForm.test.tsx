import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrandProvider } from "@/components/branding/BrandProvider";
import type { RequestBrand } from "@/lib/branding/types";
import SmsUseCaseForm from "./SmsUseCaseForm";

const PARTNER_REQUEST_BRAND: RequestBrand = {
  source: "partner_host",
  isPreview: false,
  brand: {
    kind: "partner",
    partnerId: "11111111-1111-4111-8111-111111111111",
    slug: "alpha-dog",
    name: "Alpha Dog Agency",
    publicOrigin: "https://app.alphadogagency.ai",
    logoLightUrl: null,
    logoDarkUrl: null,
    faviconUrl: null,
    colors: {
      primary: "#123456",
      primaryHover: "#234567",
      primaryActive: "#345678",
      accent: "#456789",
      primaryDark: "#56789a",
      primaryHoverDark: "#6789ab",
      primaryActiveDark: "#789abc",
      accentDark: "#89abcd",
    },
  },
};

describe("SmsUseCaseForm visible brand copy", () => {
  it("offers a separate, unchecked review-text choice only when signup is enabled", () => {
    const render = (available: boolean) => renderToStaticMarkup(
      <BrandProvider requestBrand={PARTNER_REQUEST_BRAND}>
        <SmsUseCaseForm businessId="22222222-2222-4222-8222-222222222222" businessName="Northstar" businessType="general" language="en" reviewSmsAvailable={available} onNext={vi.fn()} onBack={vi.fn()} />
      </BrandProvider>,
    );
    expect(render(false)).not.toContain("Include Google review requests");
    const enabled = render(true);
    expect(enabled).toContain("Include Google review requests");
    expect(enabled).toContain("phone call, chat, or imported number does not give that permission");
    expect(enabled).not.toMatch(/type="checkbox"[^>]*checked=""/);
  });

  it("uses the request brand for ordinary risk-review presentation", () => {
    const markup = renderToStaticMarkup(
      <BrandProvider requestBrand={PARTNER_REQUEST_BRAND}>
        <SmsUseCaseForm
          businessId="22222222-2222-4222-8222-222222222222"
          businessName="Northstar Home Care"
          businessType="general"
          language="en"
          riskReview={{
            status: "pending_review",
            storedStatus: "pending_review",
            inputHash: null,
            currentInputHash: null,
            message: "Manual review is required.",
            reason: null,
            findings: [
              {
                ruleId: "customer_not_sure",
                category: "manual_review",
                severity: "review",
                label:
                  "Customer asked SimplAssist to review restricted-service fit",
                evidence: ["Customer selected not sure"],
                source: "customer_checklist",
              },
            ],
            checklistAnswer: "not_sure",
            checklistSelections: [],
            scannedAt: null,
            notifiedAt: null,
            reviewedAt: null,
            reviewedBy: null,
            overrideNote: null,
            registrationStarted: false,
          }}
          onNext={vi.fn()}
          onBack={vi.fn()}
        />
      </BrandProvider>,
    );

    expect(markup).toContain(
      "Alpha Dog Agency will review before submitting carrier registration.",
    );
    expect(markup).toContain(
      "Alpha Dog Agency needs to review this before submitting.",
    );
    expect(markup).toContain(
      "Customer asked Alpha Dog Agency to review restricted-service fit",
    );
    expect(markup).not.toContain("SimplAssist");
  });
});
