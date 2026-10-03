import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
  vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_live_chat_only");
});
afterEach(() => vi.unstubAllEnvs());

async function renderPricing(enabled: boolean) {
  vi.stubEnv("NEXT_PUBLIC_CUSTOMER_REVIEWS_PRICING_ENABLED", enabled ? "1" : "0");
  const { default: Homepage } = await import("./page");
  const html = renderToStaticMarkup(<Homepage />);
  const pricing = html.match(/<section id="pricing"[\s\S]*?<\/section>/)?.[0];
  expect(pricing).toBeDefined();
  return pricing!;
}

describe("homepage Customers and email reviews package", () => {
  it("shows the shared package and each plan's email allowance when launched", async () => {
    const pricing = await renderPricing(true);
    expect(pricing).toContain(
      "Every plan includes a Customers workspace and Google review requests by email.",
    );
    expect(pricing).toContain('data-comparison-group="Customers &amp; reviews"');
    const chatHighlights = pricing.match(
      /<ul data-plan-highlights="chat_only"[\s\S]*?<\/ul>/,
    )?.[0];
    expect(chatHighlights).toContain("Customer workspace + 500 review emails/month");
    expect(chatHighlights?.match(/<li\b/g)).toHaveLength(5);

    const allowances = pricing.match(
      /<tr data-comparison-feature="Review emails\/billing month">[\s\S]*?<\/tr>/,
    )?.[0];
    for (const [plan, allowance] of [
      ["chat_only", "500"],
      ["sms_only", "500"],
      ["sms_and_chat", "1,000"],
      ["full", "2,000"],
    ]) {
      expect(allowances).toContain(
        `data-comparison-plan="${plan}" data-comparison-value="${allowance}"`,
      );
    }
    for (const feature of [
      "Customer workspace, notes &amp; tags",
      "Customer CSV import &amp; export",
      "Scheduled Google review requests by email",
      "One optional email reminder",
    ]) {
      const row = pricing.match(
        new RegExp(`<tr data-comparison-feature="${feature}">[\\s\\S]*?<\\/tr>`),
      )?.[0];
      expect(row?.match(/data-comparison-value="Included"/g)).toHaveLength(4);
    }
    expect(pricing).not.toMatch(/(?:SMS|text) review requests/i);
  });

  it("preserves the original pricing copy while the package launch is disabled", async () => {
    const pricing = await renderPricing(false);
    expect(pricing).not.toContain("Every plan includes a Customers workspace");
    expect(pricing).not.toContain('data-comparison-group="Customers &amp; reviews"');
    expect(pricing).not.toContain("Review emails/billing month");
    expect(pricing).toContain("Web-chat lead capture + conversation inbox");
    expect(pricing).not.toContain("Customer workspace + 500 review emails/month");
  });
});
