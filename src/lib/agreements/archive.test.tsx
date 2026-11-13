import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Parser } from "htmlparser2";
import type { ReactNode } from "react";
const settings = vi.hoisted(() => ({ fee: 2500, reviews: false }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe/config", () => ({ get SETUP_FEE_CENTS() { return settings.fee; }, get CUSTOMER_REVIEWS_PRICING_ENABLED() { return settings.reviews; } }));
vi.mock("@/components/legal/LegalDocLayout", () => ({ LegalDocLayout: ({ title, lastUpdated, children }: { title: string; lastUpdated: string; children: ReactNode }) => <article><h1>{title}</h1><p>Last updated: {lastUpdated}</p>{children}</article> }));
import TermsPage from "@/app/(public)/terms/page";
import { currentServiceTerms } from "./current.server";

function text(html: string) {
  let result = "";
  const parser = new Parser({ ontext(value) { result += value; }, onclosetag(tag) { if (["p", "h1", "h2", "li", "section"].includes(tag)) result += " "; } });
  parser.write(html); parser.end(); return result.replace(/\s+/g, " ").trim();
}
describe("archived Terms match the published document", () => {
  it.each([false, true])("preserves every section including the pricing variant %s", (reviews) => {
    settings.reviews = reviews;
    const document = currentServiceTerms();
    expect(text(document.terms_html)).toBe(text(renderToStaticMarkup(<TermsPage />)));
  });
  it("identifies changed pricing text as a different version instead of overwriting accepted text", () => {
    settings.fee = 2500; const old = currentServiceTerms();
    settings.fee = 9900; const next = currentServiceTerms(); settings.fee = 2500;
    expect(old.version).not.toBe(next.version); expect(old.terms_html).toContain("$25 setup fee");
    expect(next.terms_html).toContain("$99 setup fee");
  });
});
