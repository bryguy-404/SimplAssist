import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalComplianceUrl } from "./CompliancePanel";

const CONVERTED_FILES = [
  "./CompliancePanel.tsx",
  "./DeleteAccountModal.tsx",
  "./FAQManager.tsx",
  "./ServicesManager.tsx",
] as const;

const ORDINARY_PRODUCT_COPY_FILES = [
  "./DeleteAccountModal.tsx",
  "./FAQManager.tsx",
  "./ServicesManager.tsx",
] as const;

const DIRECT_BRAND_COLOR =
  /#(?:fff7ed|ffedd5|fed7aa|fdba74|fb923c|f97316|ea580c|c2410c|9a3412|7c2d12|431407|ff8c42|ff914d|f57f33|e8752c|ffb07a|ffd7bf|ffd5bc|fdf1e7|f5dcc4|fbe6d4|fbe7d4|291b13|e4a677|fffaf5|fff7ef|efc5a3|e9ad7b|f0e2d0|fdf3ea|e6cdb0|e8a878)(?:[0-9a-f]{2})?\b/i;
const DIRECT_BRAND_RGB =
  /rgba?\(\s*(?:234(?:\s*,\s*|\s+)88(?:\s*,\s*|\s+)12|194(?:\s*,\s*|\s+)65(?:\s*,\s*|\s+)12|154(?:\s*,\s*|\s+)52(?:\s*,\s*|\s+)18|255(?:\s*,\s*|\s+)145(?:\s*,\s*|\s+)77|249(?:\s*,\s*|\s+)115(?:\s*,\s*|\s+)22)\b/i;

function source(fileName: string): string {
  return readFileSync(new URL(fileName, import.meta.url), "utf8");
}

describe("Phase 2 Diff 8 settings collections and compliance theme", () => {
  it.each(CONVERTED_FILES)(
    "uses runtime brand variables instead of direct orange values in %s",
    (fileName) => {
      const fileSource = source(fileName);

      expect(fileSource).not.toMatch(/\borange-[0-9]{2,3}\b/i);
      expect(fileSource).not.toMatch(DIRECT_BRAND_COLOR);
      expect(fileSource).not.toMatch(DIRECT_BRAND_RGB);
    },
  );

  it.each(ORDINARY_PRODUCT_COPY_FILES)(
    "does not hardcode ordinary SimplAssist product copy in %s",
    (fileName) => {
      expect(source(fileName)).not.toContain("SimplAssist");
    },
  );

  it("preserves only the approved substantive compliance identity copy", () => {
    const complianceSource = source("./CompliancePanel.tsx");

    expect(complianceSource).toContain('title="SimplAssist-hosted (default)"');
    expect(complianceSource).toContain(
      'description="We generate and host your privacy policy and terms at SimplAssist URLs and automatically include these links in your carrier registration."',
    );
    expect(complianceSource.match(/SimplAssist/g)).toHaveLength(2);
  });

  it("builds hosted compliance links from the validated canonical origin", () => {
    expect(
      canonicalComplianceUrl(
        "/c/acme/privacy",
        "https://simplassist.com/a/path?ignored=1",
      ),
    ).toBe("https://simplassist.com/c/acme/privacy");
    expect(
      canonicalComplianceUrl(
        "/c/acme/terms",
        "http://localhost:3000/anything",
      ),
    ).toBe("http://localhost:3000/c/acme/terms");
  });

  it.each([
    "not a URL",
    "ftp://simplassist.com",
    "https://user:password@simplassist.com",
  ])("falls back safely for invalid canonical origin %s", (configured) => {
    expect(
      canonicalComplianceUrl("/c/acme/privacy", configured),
    ).toBe("https://simplassist.com/c/acme/privacy");
  });

  it("keeps hosted previews off request and partner origins", () => {
    const complianceSource = source("./CompliancePanel.tsx");

    expect(complianceSource).toContain(
      "const previewPrivacyHref = canonicalComplianceUrl(",
    );
    expect(complianceSource).toContain("`/c/${encodedSlug}/privacy`,");
    expect(complianceSource).toContain(
      "canonicalComplianceUrl(`/c/${encodedSlug}/terms`)",
    );
    expect(complianceSource).not.toContain("window.location");
    expect(complianceSource).not.toContain("useBrand");
  });

  it("preserves semantic destructive styling", () => {
    const deleteModal = source("./DeleteAccountModal.tsx");
    const faqManager = source("./FAQManager.tsx");
    const servicesManager = source("./ServicesManager.tsx");

    expect(deleteModal).toContain("bg-red-50");
    expect(deleteModal).toContain('variant="danger"');
    expect(faqManager).toContain("hover:text-red-500");
    expect(servicesManager).toContain("hover:text-red-500");
  });
});
