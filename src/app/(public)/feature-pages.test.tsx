import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/script", () => ({ default: () => null }));

import WebsiteChatPage, { generateMetadata } from "./ai-chatbot-for-small-business/page";
import VoicePage, { metadata as voiceMetadata } from "./ai-receptionist-for-small-business/page";
import sitemap from "../sitemap";

afterEach(() => vi.unstubAllEnvs());

describe("public feature pages", () => {
  it("keeps the Chat Only offer gated in both metadata and server-rendered content", () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "");
    expect(generateMetadata().title).toContain("$45/mo");
    expect(renderToStaticMarkup(<WebsiteChatPage />)).not.toContain("$10");

    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_live_chat_only");
    expect(generateMetadata().title).toContain("$10/mo");
    expect(renderToStaticMarkup(<WebsiteChatPage />)).toContain("Start with $10 Webchat");

    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "");
    expect(generateMetadata().title).toContain("$45/mo");
    expect(renderToStaticMarkup(<WebsiteChatPage />)).not.toContain("$10");
  });

  it("gives each public landing page a matching canonical, social URL, breadcrumb, and sitemap entry", () => {
    const pages = [
      { metadata: generateMetadata(), html: renderToStaticMarkup(<WebsiteChatPage />) },
      { metadata: voiceMetadata, html: renderToStaticMarkup(<VoicePage />) },
    ];
    for (const { metadata, html } of pages) {
      const canonical = metadata.alternates?.canonical;
      expect(canonical).toMatch(/^https:\/\/simplassist.com\/ai-/);
      expect(metadata.openGraph).toMatchObject({ url: canonical });
      expect(sitemap().some((entry) => entry.url === canonical)).toBe(true);
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
      expect(schema["@graph"][0].url).toBe(canonical);
      expect(schema["@graph"][1].itemListElement[1].item).toBe(canonical);
      expect(html).toContain('href="/ai-chatbot-for-small-business"');
      expect(html).toContain('href="/ai-receptionist-for-small-business"');
      expect(html).toContain('href="/#missed-call-text-back"');
    }
    expect(pages[0].metadata.alternates?.canonical).not.toBe(pages[1].metadata.alternates?.canonical);
  });

  it("uses the existing live phone destination and a functioning plan destination", () => {
    const html = renderToStaticMarkup(<VoicePage />);
    expect(html).toContain('href="tel:+15742638634"');
    expect(html).toContain('href="/signup"');
    expect(html).toContain('id="voice-plan"');
  });
});
