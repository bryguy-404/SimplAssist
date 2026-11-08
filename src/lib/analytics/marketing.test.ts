import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const GA_ID = "G-TEST123";

describe("marketing analytics boundaries", () => {
  beforeEach(() => {
    vi.resetModules();
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      location: { hostname: "simplassist.com", pathname: "/", search: "?email=private@example.com", hash: "#secret" },
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
    vi.stubGlobal("document", { referrer: "https://www.google.com/search?q=private+query", cookie: "" });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function calls() {
    return (window.dataLayer ?? []).map((entry) => Array.from(entry as IArguments));
  }

  it("keeps collection off before consent, after denial, and when storage is unavailable", async () => {
    const analytics = await import("./marketing");
    expect(analytics.startMarketingAnalytics(GA_ID)).toBe(false);
    expect(window.dataLayer).toBeUndefined();
    analytics.saveAnalyticsConsent("denied");
    expect(analytics.startMarketingAnalytics(GA_ID)).toBe(false);
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw Error("blocked"); });
    expect(analytics.startMarketingAnalytics(GA_ID)).toBe(false);
    expect(window.dataLayer).toBeUndefined();
  });

  it("never measures private, customer, partner, or preview hosts and routes", async () => {
    const { isMarketingLocation } = await import("./marketing");
    for (const path of ["/dashboard", "/conversations/123", "/api/auth/callback", "/c/some-business", "/signup/invite", "/login", "/home-v2"]) {
      expect(isMarketingLocation("simplassist.com", path)).toBe(false);
    }
    for (const host of ["app.partner.example", "localhost", "simplassist.com.evil.example", "preview.up.railway.app"]) {
      expect(isMarketingLocation(host, "/")).toBe(false);
    }
    expect(isMarketingLocation("simplassist.com", "/signup")).toBe(true);
  });

  it("deduplicates page views, strips sensitive URL data, and sends only defined signup metadata", async () => {
    const analytics = await import("./marketing");
    analytics.saveAnalyticsConsent("granted");
    expect(analytics.startMarketingAnalytics(GA_ID)).toBe(true);
    analytics.trackMarketingPageView();
    analytics.trackMarketingPageView();
    analytics.trackMarketingEvent("signup_request_submitted");
    const events = calls().filter((call) => call[0] === "event");
    expect(events.map((call) => call[1])).toEqual(["page_view", "signup_request_submitted"]);
    expect(events[0][2]).toEqual({ page_location: "https://simplassist.com/", page_title: "SimplAssist", page_referrer: "https://www.google.com/" });
    expect(events[1][2]).toMatchObject({ method: "email" });
    expect(JSON.stringify(calls())).not.toMatch(/private@example|secret|private\+query/);
    expect(calls().find((call) => call[0] === "config")?.[2]).toMatchObject({ send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false });
    Object.assign(window.location, { pathname: "/signup" });
    analytics.trackMarketingPageView();
    expect(calls().filter((call) => call[1] === "page_view")).toHaveLength(2);
  });

  it("stops pending and future collection on private routes and revocation", async () => {
    const analytics = await import("./marketing");
    analytics.saveAnalyticsConsent("granted");
    analytics.startMarketingAnalytics(GA_ID);
    analytics.trackMarketingPageView();
    Object.assign(window.location, { pathname: "/dashboard" });
    analytics.trackMarketingPageView();
    expect((window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`]).toBe(true);
    analytics.trackMarketingEvent("demo_chat_open");
    Object.assign(window.location, { pathname: "/" });
    analytics.startMarketingAnalytics(GA_ID);
    analytics.saveAnalyticsConsent("denied");
    const count = calls().length;
    analytics.trackMarketingEvent("demo_voice_click");
    expect(calls()).toHaveLength(count);
    expect((window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`]).toBe(true);
  });

  it("expires consent and ignores malformed stored preferences", async () => {
    const analytics = await import("./marketing");
    window.localStorage.setItem(analytics.ANALYTICS_CONSENT_KEY, "bad json");
    expect(analytics.readAnalyticsConsent()).toBeNull();
    window.localStorage.setItem(analytics.ANALYTICS_CONSENT_KEY, JSON.stringify({ choice: "granted", expires: Date.now() - 1 }));
    expect(analytics.startMarketingAnalytics(GA_ID)).toBe(false);
    expect(analytics.isMeasurementId("G-123\" onload=bad")).toBe(false);
  });
});
