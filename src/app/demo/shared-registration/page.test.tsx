import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not_found"); } }));
vi.mock("@/lib/theme-v2/ui", () => ({ ThemeToggleV2: () => null }));
import Page, { generateMetadata } from "./page";
afterEach(() => vi.unstubAllEnvs());

describe("shared registration visual fixture", () => {
  it("is inaccessible in production unless demo pages were explicitly enabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_DEMO_PAGES", "0");
    expect(() => Page({})).toThrow("not_found");
    expect(() => generateMetadata()).toThrow("not_found");
  });
  it("uses the real locked fields with synthetic values and no submitting form", () => {
    const html = renderToStaticMarkup(Page({}));
    expect(html).toContain("Synthetic local preview");
    expect(html).toContain("100 Synthetic Private Street");
    expect(html).toContain("readonly");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('type="submit"');
  });
  it("keeps the private fixture address out of the public policy view", () => {
    const html = renderToStaticMarkup(Page({ searchParams: { view: "public" } }));
    expect(html).toContain("Example Studio is operated by Example Operator LLC");
    expect(html).toContain("South Bend, IN");
    expect(html).not.toContain("Synthetic Private Street");
    expect(html).not.toContain("46601");
  });
});
