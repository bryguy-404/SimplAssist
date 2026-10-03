import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  getActiveSmsNumber: vi.fn(),
  getRequestBrand: vi.fn(),
  notFound: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/font/local", () => ({
  default: () => ({ variable: "font-test-variable" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/messaging/phoneNumberLookup", () => ({
  getActiveSmsNumberForBusiness: mocks.getActiveSmsNumber,
}));
vi.mock("@/lib/branding/requestBrand.server", () => ({
  getRequestBrand: mocks.getRequestBrand,
}));
vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}));
vi.mock("@/lib/theme-v2/ui", () => ({
  ThemeToggleV2: () => null,
}));

import {
  buildSmsComplianceCopy,
  MOBILE_INFORMATION_SHARING_DISCLOSURE,
} from "@/lib/messaging/complianceCopy";
import { verifyPublishedCompliancePage } from "@/lib/messaging/registration/publicCompliancePage";
import RootLayout from "../../../layout";
import BusinessLandingPage, { dynamic } from "./page";
import PerBusinessPrivacyPage, {
  dynamic as privacyDynamic,
} from "./privacy/page";

const APP_ORIGIN = "https://app.example.test";
const BUSINESS_ID = "00000000-0000-4000-8000-000000000123";
const SLUG = "northstar-home-care";
const SMS_NUMBER = "+13175550123";
const CONTACT_NUMBER = "+13175550199";

const DEFAULT_REQUEST_BRAND = {
  source: "default" as const,
  isPreview: false,
  brand: {
    kind: "default" as const,
    partnerId: null,
    slug: null,
    name: "SimplAssist",
    publicOrigin: "https://simplassist.com",
    logoLightUrl: "/logo-light.png",
    logoDarkUrl: "/logo-dark.png",
    faviconUrl: "/favicon-2.png",
    colors: {
      primary: "#ea580c",
      primaryHover: "#c2410c",
      primaryActive: "#9a3412",
      accent: "#c2410c",
      primaryDark: "#ff914d",
      primaryHoverDark: "#f57f33",
      primaryActiveDark: "#e8752c",
      accentDark: "#ff914d",
    },
  },
};

const BUSINESS = {
  id: BUSINESS_ID,
  slug: SLUG,
  name: "Northstar & Sons Home Care",
  business_type: "home_services",
  email: "help@northstar.example",
  phone_number: CONTACT_NUMBER,
  address: "100 Main Street",
  city: "Indianapolis",
  state: "IN",
  zip: "46204",
  // Deliberately stale extra data: the page's projection excludes this field,
  // and rendering must use the live shared copy instead.
  opt_in_description: "STALE PERSISTED OPT-IN COPY",
  ai_settings: { language: "en" as const },
};

const HOURS = [
  {
    day_of_week: 1,
    open_time: "09:00:00",
    close_time: "17:00:00",
    is_closed: false,
  },
];

type QueryResult = { data: unknown; error: { message: string } | null };
const tableResults = new Map<string, QueryResult>();
const tableQueries = new Map<
  string,
  Array<Record<string, ReturnType<typeof vi.fn>>>
>();

function makeQuery(table: string, result: QueryResult) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "order", "maybeSingle"]) {
    query[method] = vi.fn(() => query);
  }
  const promise = Promise.resolve(result);
  Object.assign(query, {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
  });
  const queries = tableQueries.get(table) ?? [];
  queries.push(query);
  tableQueries.set(table, queries);
  return query;
}

function visibleText(html: string): string {
  return html
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x27|39);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function renderPage() {
  const element = await BusinessLandingPage({
    params: Promise.resolve({ slug: SLUG }),
  });
  return renderToStaticMarkup(element);
}

async function renderPrivacyPage() {
  const element = await PerBusinessPrivacyPage({
    params: Promise.resolve({ slug: SLUG }),
  });
  return renderToStaticMarkup(element);
}

function complianceBlockquotes(html: string): string[] {
  return Array.from(
    html.matchAll(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/g),
    (match) => match[0]
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tableResults.clear();
  tableQueries.clear();
  tableResults.set("businesses", { data: BUSINESS, error: null });
  tableResults.set("review_sms_accounts", { data: null, error: null });
  tableResults.set("business_hours", { data: HOURS, error: null });
  mocks.from.mockImplementation((table: string) => {
    const result = tableResults.get(table);
    if (!result) throw new Error(`Unexpected table ${table}`);
    return makeQuery(table, result);
  });
  mocks.getActiveSmsNumber.mockResolvedValue(SMS_NUMBER);
  mocks.getRequestBrand.mockResolvedValue(DEFAULT_REQUEST_BRAND);
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  vi.stubEnv("NEXT_PUBLIC_APP_URL", `${APP_ORIGIN}/`);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("/c/[slug] compliance page", () => {
  it("is force-dynamic and renders the active SMS number plus every disclosure in raw HTML", async () => {
    const html = await renderPage();
    const text = visibleText(html);
    const expectedCopy = buildSmsComplianceCopy({
      business: BUSINESS,
      smsPhoneNumber: SMS_NUMBER,
      smsEntryPoint: `this page (/c/${SLUG})`,
      privacyUrl: `/c/${SLUG}/privacy`,
      language: BUSINESS.ai_settings.language,
    });
    const blockquotes = complianceBlockquotes(html);

    expect(dynamic).toBe("force-dynamic");
    expect(html).not.toContain("<script");
    expect(html).toContain(
      '<section aria-labelledby="sms-contact-heading"'
    );
    expect(html).toMatch(
      /<h2 id="sms-contact-heading"[^>]*>SMS customer care<\/h2>/
    );
    const ctaMarkup = html.match(
      /<a href="sms:\+13175550123"[\s\S]*?<\/a>/
    )?.[0];
    expect(ctaMarkup).toContain("font-bold");
    expect(ctaMarkup).toContain("rounded-full");
    expect(ctaMarkup).toContain("px-5");
    expect(ctaMarkup).toContain("py-3");
    expect(html).toContain(`href="sms:${SMS_NUMBER}"`);
    expect(html).toContain(`href="tel:${CONTACT_NUMBER}"`);
    expect(html).toContain(`href="/c/${SLUG}/privacy"`);
    expect(text).toContain(`Text us at ${SMS_NUMBER}`);
    expect(text).toContain("SMS opt-in and program details");
    expect(text).toContain(
      `Inbound SMS opt-in: customers text ${SMS_NUMBER}, published at this page (/c/${SLUG})`
    );
    expect(blockquotes).toHaveLength(2);
    expect(visibleText(blockquotes[0])).toBe(
      `“${expectedCopy.confirmationSms.replace(/\s+/g, " ")}”`
    );
    expect(blockquotes[0]).toContain("whitespace-pre-line");
    expect(blockquotes[0]).toContain("\n\n");
    expect(visibleText(blockquotes[1])).toBe(
      `“${expectedCopy.voicemailGreeting}”`
    );
    expect(text).toContain("a call or live conversation alone is not SMS consent");
    expect(text).toContain("Message frequency Message frequency varies by conversation.");
    expect(text).toContain(
      "Message and data rates Message and data rates may apply."
    );
    expect(text).toContain("HELP Reply HELP for help.");
    expect(text).toContain("STOP Reply STOP to opt out.");
    expect(text).toContain(
      `Mobile information sharing ${MOBILE_INFORMATION_SHARING_DISCLOSURE}`
    );
    expect(text).toContain(`Privacy Policy Privacy Policy: /c/${SLUG}/privacy.`);
    expect(text).not.toContain("STALE PERSISTED OPT-IN COPY");

    expect(html).toContain('<dl class="mt-4 grid gap-3 sm:grid-cols-2">');
    for (const label of [
      "Message frequency",
      "Message and data rates",
      "HELP",
      "STOP",
      "Mobile information sharing",
    ]) {
      expect(html).toMatch(new RegExp(`<dt[^>]*>${label}</dt>`));
    }

    expect(mocks.getActiveSmsNumber).toHaveBeenCalledWith(BUSINESS_ID);
    const businessQuery = tableQueries.get("businesses")?.[0];
    expect(businessQuery?.select).toHaveBeenCalledWith(
      "id, slug, name, business_type, email, phone_number, address, city, state, zip, review_sms_signup_enabled, ai_settings(language)"
    );
  });

  it("renders both quoted scripts from the same Spanish canonical copy", async () => {
    const spanishBusiness = {
      ...BUSINESS,
      ai_settings: { language: "es" as const },
    };
    tableResults.set("businesses", {
      data: spanishBusiness,
      error: null,
    });

    const html = await renderPage();
    const blockquotes = complianceBlockquotes(html);
    const expectedCopy = buildSmsComplianceCopy({
      business: spanishBusiness,
      smsPhoneNumber: SMS_NUMBER,
      smsEntryPoint: `this page (/c/${SLUG})`,
      privacyUrl: `/c/${SLUG}/privacy`,
      language: spanishBusiness.ai_settings.language,
    });

    expect(blockquotes).toHaveLength(2);
    expect(visibleText(blockquotes[0])).toBe(
      `“${expectedCopy.confirmationSms.replace(/\s+/g, " ")}”`
    );
    expect(blockquotes[0]).toContain("whitespace-pre-line");
    expect(blockquotes[0]).toContain("\n\n");
    expect(visibleText(blockquotes[1])).toBe(
      `“${expectedCopy.voicemailGreeting}”`
    );
  });

  it("server-renders a reachable privacy target with the active number and carrier disclosures", async () => {
    const html = await renderPrivacyPage();
    const text = visibleText(html);

    expect(privacyDynamic).toBe("force-dynamic");
    expect(html).not.toContain("<script");
    expect(html).toContain(`href="/c/${SLUG}"`);
    expect(text).toContain("Privacy Policy");
    expect(text).toContain(BUSINESS.name);
    expect(text).toContain(SMS_NUMBER);
    expect(text).toContain("Message frequency varies");
    expect(text).toContain("Message and data rates may apply");
    expect(text).toContain("replying STOP");
    expect(text).toContain("reply HELP");
    expect(text).toContain(MOBILE_INFORMATION_SHARING_DISCLOSURE);
    expect(text).not.toContain("STALE PERSISTED OPT-IN COPY");

    expect(mocks.getActiveSmsNumber).toHaveBeenCalledWith(BUSINESS_ID);
    const businessQuery = tableQueries.get("businesses")?.[0];
    expect(businessQuery?.select).toHaveBeenCalledWith(
      "id, slug, name, email, phone_number, address, city, state, zip, review_sms_signup_enabled, opt_in_description, ai_settings(language)"
    );
  });

  it("builds generated legal copy with the business language", async () => {
    const spanishBusiness = {
      ...BUSINESS,
      ai_settings: { language: "es" as const },
    };
    tableResults.set("businesses", {
      data: spanishBusiness,
      error: null,
    });

    const html = await renderPrivacyPage();
    const text = visibleText(html);
    const expectedCopy = buildSmsComplianceCopy({
      business: spanishBusiness,
      smsPhoneNumber: SMS_NUMBER,
      privacyUrl: "this Privacy Policy",
      language: spanishBusiness.ai_settings.language,
    });

    expect(text).toContain(
      expectedCopy.legalOptInDescription.replace(/\s+/g, " ")
    );
  });

  it("produces server HTML accepted by the pre-submit live-page verifier", async () => {
    const pageHtml = await renderPage();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<html><head><title>Compliance</title></head><body>${pageHtml}</body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }
        )
      )
    );

    await expect(
      verifyPublishedCompliancePage({
        slug: SLUG,
        businessName: BUSINESS.name,
        smsPhoneNumber: SMS_NUMBER,
        language: BUSINESS.ai_settings.language,
      })
    ).resolves.toBeUndefined();
  });

  it("produces an eligible raw document through the actual root layout", async () => {
    const page = await BusinessLandingPage({
      params: Promise.resolve({ slug: SLUG }),
    });
    const rootHtml = renderToStaticMarkup(
      await RootLayout({ children: page })
    );
    const documentHtml = rootHtml.replace(
      /(<html[^>]*>)/,
      "$1<head><title>Compliance</title><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head>"
    );

    expect(documentHtml).not.toContain(
      "fixed bottom-4 right-4 z-50"
    );
    expect(documentHtml).not.toContain("<style");
    expect(documentHtml).toContain("pointer-events-none fixed inset-0 -z-10");
    const inlineScriptHashes = Array.from(
      documentHtml.matchAll(/<script>([\s\S]*?)<\/script>/g),
      (match) =>
        createHash("sha256").update(match[1].trim()).digest("hex")
    );
    expect(inlineScriptHashes).toEqual([
      "71df87a674ac2da133d6529604d9fe93ec4e7b59b6a796607e3a3236f1f2f5e5",
    ]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(documentHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      )
    );

    await expect(
      verifyPublishedCompliancePage({
        slug: SLUG,
        businessName: BUSINESS.name,
        smsPhoneNumber: SMS_NUMBER,
        language: BUSINESS.ai_settings.language,
      })
    ).resolves.toBeUndefined();
  });

  it("keeps the public business page reachable but publishes no SMS claims without an active number", async () => {
    mocks.getActiveSmsNumber.mockResolvedValue(null);

    const html = await renderPage();
    const text = visibleText(html);

    expect(text).toContain(BUSINESS.name);
    expect(html).toContain(`href="tel:${CONTACT_NUMBER}"`);
    expect(html).not.toContain("href=\"sms:");
    expect(text).not.toContain("SMS customer care");
    expect(text).not.toContain("SMS opt-in and program details");
    expect(text).not.toContain("Message frequency varies by conversation.");
  });

  it("fails closed instead of hiding an active-number lookup error", async () => {
    mocks.getActiveSmsNumber.mockRejectedValue(new Error("lookup failed closed"));

    await expect(renderPage()).rejects.toThrow("lookup failed closed");
  });

  it("returns not-found for pending slugs without reading business or number data", async () => {
    await expect(
      BusinessLandingPage({
        params: Promise.resolve({ slug: "pending-12345678" }),
      })
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.getActiveSmsNumber).not.toHaveBeenCalled();
  });

  it("returns not-found when the public business row is missing", async () => {
    tableResults.set("businesses", { data: null, error: null });

    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getActiveSmsNumber).not.toHaveBeenCalled();
  });
});

describe("review programs on public business pages", () => {
  it("shows a separate permission path for a new MIXED signup", async () => {
    tableResults.set("businesses", { data: { ...BUSINESS, review_sms_signup_enabled: true }, error: null });
    const html = await renderPage();
    expect(html).toContain("Review requests by text");
    expect(html).toContain(`/c/${SLUG}/review-texts`);
    expect(html).toContain("SMS customer care");
    expect(visibleText(html)).toContain(`text REVIEWS to ${SMS_NUMBER}`);
  });

  it("describes a Chat review-only account without advertising customer-care service", async () => {
    tableResults.set("review_sms_accounts", { data: { billing_source: "direct", state: "carrier_pending", draft: { consentMode: "hosted_keyword" } }, error: null });
    const html = await renderPage();
    expect(html).toContain("Review requests by text");
    expect(html).not.toContain("SMS customer care");
    expect(html).not.toContain("Voicemail opt-in");
    const privacy = await renderPrivacyPage();
    expect(visibleText(privacy)).toContain("voluntary review-request SMS program");
    expect(visibleText(privacy)).not.toContain("customer-care text messages");
  });
});
