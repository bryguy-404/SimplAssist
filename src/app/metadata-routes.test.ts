import { describe, expect, it } from "vitest";
import { config as middlewareConfig } from "@/middleware";
import robots from "./robots";
import sitemap from "./sitemap";

describe("search-engine metadata routes", () => {
  it("publishes the exact curated corporate sitemap", () => {
    expect(sitemap()).toEqual([
      { url: "https://simplassist.com" },
      { url: "https://simplassist.com/ai-chatbot-for-small-business" },
      { url: "https://simplassist.com/ai-receptionist-for-small-business" },
      { url: "https://simplassist.com/support" },
      { url: "https://simplassist.com/support/setup-fee" },
      { url: "https://simplassist.com/privacy" },
      { url: "https://simplassist.com/terms" },
    ]);
  });

  it("allows public pages while disallowing private and application routes", () => {
    const result = robots();

    expect(result).toEqual({
      rules: {
        userAgent: "*",
        allow: ["/", "/c/"],
        disallow: [
          "/api/",
          "/admin",
          "/login",
          "/signup",
          "/account-deleted",
          "/onboarding",
          "/dashboard",
          "/billing",
          "/calendar",
          "/contacts",
          "/conversations",
          "/knowledge-gaps",
          "/settings",
          "/widget$",
          "/widget/preview",
          "/waitlist/",
        ],
      },
      sitemap: "https://simplassist.com/sitemap.xml",
      host: "https://simplassist.com",
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/demo");
    expect(serialized).not.toContain("/home-v2");
  });

  it("keeps robots and sitemap requests out of session-refresh middleware", () => {
    const matcher = new RegExp(`^${middlewareConfig.matcher[0]}$`);

    expect(matcher.test("/robots.txt")).toBe(false);
    expect(matcher.test("/sitemap.xml")).toBe(false);
    expect(matcher.test("/dashboard")).toBe(true);
  });
});
