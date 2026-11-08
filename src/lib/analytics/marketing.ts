// Deliberately limited to SimplAssist's acquisition pages. Never add customer,
// dashboard, callback, or partner routes to this list.
const PAGE_TITLES: Record<string, string> = {
  "/": "SimplAssist",
  "/ai-chatbot-for-small-business": "AI Chatbot for Small Business | SimplAssist",
  "/ai-receptionist-for-small-business": "AI Receptionist for Small Business | SimplAssist",
  "/ai-receptionist-for-plumbing-and-hvac": "AI Receptionist for Plumbing and HVAC | SimplAssist",
  "/support": "Support | SimplAssist",
  "/support/setup-fee": "SMS Setup Fee | SimplAssist",
  "/privacy": "Privacy Policy | SimplAssist",
  "/terms": "Terms of Service | SimplAssist",
  "/signup": "Create your account | SimplAssist",
};

export const ANALYTICS_CONSENT_KEY = "sa-analytics-consent-v1";
export const ANALYTICS_SETTINGS_EVENT = "sa-analytics-settings";
export const CONSENT_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
export type AnalyticsConsent = "granted" | "denied";
export type MarketingEvent =
  | "demo_chat_open"
  | "demo_voice_click"
  | "signup_click"
  | "signup_request_submitted";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let activeMeasurementId: string | null = null;
let previousPage: string | null = null;
let paused = true;

export function isMeasurementId(value: string): boolean {
  return /^G-[A-Z0-9]+$/.test(value);
}

export function isMarketingLocation(hostname: string, pathname: string): boolean {
  return (hostname === "simplassist.com" || hostname === "www.simplassist.com") &&
    Object.hasOwn(PAGE_TITLES, pathname);
}

export function readAnalyticsConsent(): AnalyticsConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const saved = JSON.parse(window.localStorage.getItem(ANALYTICS_CONSENT_KEY) || "null");
    if (!saved || !["granted", "denied"].includes(saved.choice) ||
      typeof saved.expires !== "number" || saved.expires <= Date.now()) return null;
    return saved.choice;
  } catch {
    return null;
  }
}

function setDisabled(disabled: boolean) {
  if (activeMeasurementId) {
    (window as unknown as Record<string, unknown>)[`ga-disable-${activeMeasurementId}`] = disabled;
  }
}

export function pauseMarketingAnalytics() {
  paused = true;
  setDisabled(true);
  previousPage = null;
}

export function saveAnalyticsConsent(choice: AnalyticsConsent) {
  // Stop collection before updating either persistent choice or Google's state.
  if (choice === "denied") pauseMarketingAnalytics();
  try {
    window.localStorage.setItem(ANALYTICS_CONSENT_KEY, JSON.stringify({
      choice, expires: Date.now() + CONSENT_MAX_AGE_MS,
    }));
  } catch {
    // If persistence is blocked, collection remains off (fail closed).
    try { window.localStorage.removeItem(ANALYTICS_CONSENT_KEY); } catch { /* Unavailable storage. */ }
  }
  if (choice === "denied") {
    window.gtag?.("consent", "update", { analytics_storage: "denied" });
    // These are the only analytics cookies we create, on the canonical domain.
    for (const entry of document.cookie.split(";")) {
      const name = entry.trim().split("=")[0];
      if (name === "_ga" || name.startsWith("_ga_")) {
        for (const domain of ["", "; domain=simplassist.com", "; domain=.simplassist.com"]) {
          document.cookie = `${name}=; Max-Age=0; path=/${domain}; SameSite=Lax; Secure`;
        }
      }
    }
  }
}

export function safeReferrer(raw: string): string {
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol)) return "";
    // Retain the referring website for acquisition reports, never its query,
    // fragment, credentials, or potentially private document path.
    return `${url.origin}/`;
  } catch {
    return "";
  }
}

export function marketingPageContext(pathname: string, referrer: string) {
  return {
    page_location: `https://simplassist.com${pathname}`,
    page_title: PAGE_TITLES[pathname],
    page_referrer: safeReferrer(referrer),
  };
}

function canMeasure() {
  return typeof window !== "undefined" &&
    isMarketingLocation(window.location.hostname, window.location.pathname) &&
    readAnalyticsConsent() === "granted";
}

export function startMarketingAnalytics(measurementId: string): boolean {
  if (!isMeasurementId(measurementId) || !canMeasure()) return false;
  if (!activeMeasurementId) {
    activeMeasurementId = measurementId;
    window.dataLayer = window.dataLayer || [];
    // Google's command queue uses Arguments objects (the documented gtag shim).
    // eslint-disable-next-line prefer-rest-params
    window.gtag = function () { window.dataLayer!.push(arguments); };
    window.gtag("consent", "default", {
      analytics_storage: "denied", ad_storage: "denied",
      ad_user_data: "denied", ad_personalization: "denied",
    });
    window.gtag("consent", "update", { analytics_storage: "granted" });
    const settings = {
      ...marketingPageContext(window.location.pathname, document.referrer),
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_domain: "simplassist.com",
      cookie_expires: CONSENT_MAX_AGE_MS / 1000,
      cookie_flags: "SameSite=Lax;Secure",
    };
    // New unified Google tags initialize without waiting for legacy config.
    // Apply global defaults before initialization; the destination tag's UI
    // configuration also disables automatic page views and advertising.
    window.gtag("set", settings);
    window.gtag("js", new Date());
    window.gtag("config", measurementId, settings);
  } else {
    window.gtag?.("consent", "update", { analytics_storage: "granted" });
  }
  setDisabled(false);
  paused = false;
  return true;
}

export function trackMarketingPageView() {
  if (!activeMeasurementId || paused || !canMeasure()) {
    pauseMarketingAnalytics();
    return;
  }
  const pathname = window.location.pathname;
  if (previousPage === pathname) return;
  const context = marketingPageContext(pathname, document.referrer);
  if (previousPage) context.page_referrer = `https://simplassist.com${previousPage}`;
  previousPage = pathname;
  // Also override the defaults used by Google's automatic session/engagement
  // events, so URL parameters and dynamic document titles never enter reports.
  window.gtag?.("set", context);
  window.gtag?.("event", "page_view", context);
}

export function trackMarketingEvent(event: MarketingEvent) {
  if (!activeMeasurementId || paused || !canMeasure()) return;
  window.gtag?.("event", event, {
    ...marketingPageContext(window.location.pathname, document.referrer),
    ...(event === "signup_request_submitted" ? { method: "email" } : {}),
  });
}
