import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildSmsComplianceCopy } from "@/lib/messaging/complianceCopy";
import type { Language } from "@/types/database";
import {
  PublicCompliancePageVerificationError,
  verifyPublishedCompliancePage,
} from "./publicCompliancePage";

const APP_ORIGIN = "https://app.example.test";
const SLUG = "northstar-home-care";
const BUSINESS_NAME = "Northstar & Sons Home Care";
const SMS_NUMBER = "+13175550123";
const PAGE_URL = `${APP_ORIGIN}/c/${SLUG}`;
const PRIVACY_HREF = `/c/${SLUG}/privacy`;

const VERIFY_ARGS = {
  slug: SLUG,
  businessName: BUSINESS_NAME,
  smsPhoneNumber: SMS_NUMBER,
};

const copy = buildSmsComplianceCopy({
  business: { name: BUSINESS_NAME, email: null, phone_number: null },
  smsPhoneNumber: SMS_NUMBER,
  smsEntryPoint: `this page (/c/${SLUG})`,
  privacyUrl: PRIVACY_HREF,
});
const spanishCopy = buildSmsComplianceCopy({
  business: { name: BUSINESS_NAME, email: null, phone_number: null },
  smsPhoneNumber: SMS_NUMBER,
  smsEntryPoint: `this page (/c/${SLUG})`,
  privacyUrl: PRIVACY_HREF,
  language: "es",
});
const NEXT_THEMES_SCRIPT =
  '((e,t,r,n,o,l,a,i)=>{let u=document.documentElement,s=["light","dark"];function c(t){(Array.isArray(e)?e:[e]).forEach(e=>{let r="class"===e,n=r&&l?o.map(e=>l[e]||e):o;r?(u.classList.remove(...n),u.classList.add(l&&l[t]?l[t]:t)):u.setAttribute(e,t)}),i&&s.includes(t)&&(u.style.colorScheme=t)}if(n)c(n);else try{let e=localStorage.getItem(t)||r,n=a&&"system"===e?window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light":e;c(n)}catch(e){}})("class","theme","system",null,["light","dark"],null,true,true)';
const ROOT_BRAND_STYLE = [
  "--brand-primary:#ea580c",
  "--brand-primary-hover:#c2410c",
  "--brand-primary-active:#9a3412",
  "--brand-accent:#c2410c",
  "--brand-primary-dark:#ff914d",
  "--brand-primary-hover-dark:#f57f33",
  "--brand-primary-active-dark:#e8752c",
  "--brand-accent-dark:#ff914d",
  "--brand-primary-rgb:234 88 12",
  "--brand-primary-hover-rgb:194 65 12",
  "--brand-primary-active-rgb:154 52 18",
  "--brand-accent-rgb:194 65 12",
  "--brand-primary-dark-rgb:255 145 77",
  "--brand-primary-hover-dark-rgb:245 127 51",
  "--brand-primary-active-dark-rgb:232 117 44",
  "--brand-accent-dark-rgb:255 145 77",
  "--brand-accent-soft:#fdf1e7",
  "--brand-accent-soft-border:#f5dcc4",
  "--brand-accent-soft-dark:#ffd7bf",
  "--brand-primary-soft-dark:#ffb07a",
  "--brand-tint-strong:#fbe6d4",
  "--brand-tint:#fbe7d4",
  "--brand-text-soft-dark:#ffd5bc",
  "--brand-surface-dark:#291b13",
  "--brand-selection-border:#e4a677",
  "--brand-wash-faint:#fffaf5",
  "--brand-wash:#fff7ef",
  "--brand-border-soft:#efc5a3",
  "--brand-border-strong:#e9ad7b",
  "--brand-calendar-border:#f0e2d0",
  "--brand-calendar-wash:#fdf3ea",
  "--brand-calendar-muted:#e6cdb0",
  "--brand-calendar-accent:#e8a878",
  "--brand-primary-alt:#f97316",
  "--brand-primary-alt-rgb:249 115 22",
  "--brand-primary-alt-wash:#fff7ed",
].join(";");

type Marker =
  | "cta_text"
  | "sms_href"
  | "purpose"
  | "introduction"
  | "inbound_sms"
  | "confirmation_sms"
  | "voicemail_path"
  | "voicemail_script"
  | "frequency"
  | "rates"
  | "help"
  | "stop"
  | "sharing"
  | "privacy_text"
  | "privacy_href";

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function definition(
  marker: Marker,
  omitted: Marker | undefined,
  label: string,
  value: string
): string {
  if (marker === omitted) return "";
  return `<div data-definition="${marker}"><dt>${label}</dt><dd data-value="${marker}">${escapeHtmlText(value)}</dd></div>`;
}

/** Mirrors the semantic section and dt/dd boundaries emitted by /c/[slug]. */
function validHtml(
  omitted?: Marker,
  language?: Language | null
): string {
  const renderedCopy = buildSmsComplianceCopy({
    business: { name: BUSINESS_NAME, email: null, phone_number: null },
    smsPhoneNumber: SMS_NUMBER,
    smsEntryPoint: `this page (/c/${SLUG})`,
    privacyUrl: PRIVACY_HREF,
    language,
  });
  const smsHref = omitted === "sms_href" ? "/contact" : `sms:${SMS_NUMBER}`;
  const ctaText =
    omitted === "cta_text"
      ? "Contact customer care"
      : `Text us at ${SMS_NUMBER}`;
  const privacyHref =
    omitted === "privacy_href" ? "/privacy-unpublished" : PRIVACY_HREF;
  const privacyText =
    omitted === "privacy_text"
      ? "Read our privacy information."
      : renderedCopy.disclosures.privacyPolicy;

  return [
    "<!doctype html><html><head><title>Compliance</title></head><body>",
    '<main data-compliance-root="true">',
    '<section data-block="sms-contact">',
    "<h2>SMS customer care</h2>",
    `<a data-role="sms-cta" href="${smsHref}">${escapeHtmlText(ctaText)}</a>`,
    omitted === "purpose"
      ? ""
      : `<p data-value="purpose">${escapeHtmlText(renderedCopy.disclosures.purpose)}</p>`,
    "</section>",
    '<section data-block="introduction">',
    "<h2>SMS opt-in and program details</h2>",
    omitted === "introduction"
      ? ""
      : `<p>${escapeHtmlText(renderedCopy.optInPaths.introduction)}</p>`,
    "</section>",
    '<section data-block="text-message-opt-in">',
    "<h3>Text-message opt-in</h3>",
    omitted === "inbound_sms"
      ? ""
      : `<p>${escapeHtmlText(renderedCopy.optInPaths.inboundSms)}</p>`,
    omitted === "confirmation_sms"
      ? ""
      : `<h4>Confirmation SMS</h4><blockquote>“<!-- -->${escapeHtmlText(renderedCopy.confirmationSms)}<!-- -->”</blockquote>`,
    "</section>",
    '<section data-block="voicemail-opt-in">',
    "<h3>Voicemail opt-in</h3>",
    omitted === "voicemail_path"
      ? ""
      : `<p>${escapeHtmlText(renderedCopy.optInPaths.voicemail)}</p><p>${escapeHtmlText(renderedCopy.optInPaths.callForwarding)}</p>`,
    omitted === "voicemail_script"
      ? ""
      : `<h4>What callers hear before leaving a message</h4><blockquote>“<!-- -->${escapeHtmlText(renderedCopy.voicemailGreeting)}<!-- -->”</blockquote>`,
    "</section>",
    '<section data-block="program-disclosures">',
    "<h3>Program disclosures</h3><dl>",
    definition(
      "frequency",
      omitted,
      "Message frequency",
      renderedCopy.disclosures.frequency
    ),
    definition(
      "rates",
      omitted,
      "Message and data rates",
      renderedCopy.disclosures.rates
    ),
    definition("help", omitted, "HELP", renderedCopy.disclosures.help),
    definition("stop", omitted, "STOP", renderedCopy.disclosures.stop),
    definition(
      "sharing",
      omitted,
      "Mobile information sharing",
      renderedCopy.disclosures.mobileInformationSharing
    ),
    omitted === "privacy_text"
      ? `<div data-definition="privacy"><dt>Privacy Policy</dt><dd><a data-role="privacy-link" href="${privacyHref}">${privacyText}</a></dd></div>`
      : omitted === "privacy_href"
        ? `<div data-definition="privacy"><dt>Privacy Policy</dt><dd><a data-role="privacy-link" href="${privacyHref}">${escapeHtmlText(privacyText)}</a></dd></div>`
        : `<div data-definition="privacy"><dt>Privacy Policy</dt><dd><a data-role="privacy-link" href="${privacyHref}">${escapeHtmlText(privacyText)}</a></dd></div>`,
    "</dl></section></main></body></html>",
  ].join("");
}

function htmlResponse(html: string, status = 200, contentType = "text/html") {
  return new Response(html, {
    status,
    headers: { "content-type": contentType },
  });
}

function bodyContent(html: string): string {
  const start = html.indexOf("<body>");
  const end = html.lastIndexOf("</body>");
  if (start < 0 || end < 0) throw new Error("Fixture body not found");
  return html.slice(start + "<body>".length, end);
}

function documentWithBody(content: string, attributes = ""): string {
  return `<!doctype html><html><head><title>Compliance</title></head><body${attributes ? ` ${attributes}` : ""}>${content}</body></html>`;
}

function addAttributes(
  html: string,
  openingTagPrefix: string,
  attributes: string
): string {
  if (!html.includes(openingTagPrefix)) {
    throw new Error(`Opening tag not found: ${openingTagPrefix}`);
  }
  return html.replace(openingTagPrefix, `${openingTagPrefix} ${attributes}`);
}

function appendToRoot(html: string, fragment: string): string {
  return html.replace("</main>", `${fragment}</main>`);
}

async function expectRejected(html: string, message?: string): Promise<void> {
  vi.mocked(fetch).mockResolvedValue(htmlResponse(html));
  const assertion = expect(verifyPublishedCompliancePage(VERIFY_ARGS)).rejects;
  if (message) {
    await assertion.toMatchObject({
      name: "PublicCompliancePageVerificationError",
      message: expect.stringContaining(message),
    });
  } else {
    await assertion.toBeInstanceOf(PublicCompliancePageVerificationError);
  }
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", `${APP_ORIGIN}/`);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(validHtml())));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("verifyPublishedCompliancePage", () => {
  it("accepts every required semantic disclosure in raw server HTML", async () => {
    await expect(
      verifyPublishedCompliancePage(VERIFY_ARGS)
    ).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      PAGE_URL,
      expect.objectContaining({
        cache: "no-store",
        headers: {
          accept: "text/html",
          "cache-control": "no-cache",
        },
        redirect: "error",
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("verifies both quoted scripts against the explicitly selected locale", async () => {
    vi.mocked(fetch).mockResolvedValue(
      htmlResponse(validHtml(undefined, "es"))
    );

    await expect(
      verifyPublishedCompliancePage({
        ...VERIFY_ARGS,
        language: "es",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects stale or mixed-language quoted scripts", async () => {
    vi.mocked(fetch).mockResolvedValue(htmlResponse(validHtml()));
    await expect(
      verifyPublishedCompliancePage({
        ...VERIFY_ARGS,
        language: "es",
      })
    ).rejects.toThrow("required visible SMS disclosure");

    const mixedHtml = validHtml(undefined, "es").replace(
      escapeHtmlText(spanishCopy.voicemailGreeting),
      escapeHtmlText(copy.voicemailGreeting)
    );
    vi.mocked(fetch).mockResolvedValue(htmlResponse(mixedHtml));
    await expect(
      verifyPublishedCompliancePage({
        ...VERIFY_ARGS,
        language: "es",
      })
    ).rejects.toThrow("required visible SMS disclosure");
  });

  it.each<Marker>([
    "cta_text",
    "sms_href",
    "purpose",
    "introduction",
    "inbound_sms",
    "confirmation_sms",
    "voicemail_path",
    "voicemail_script",
    "frequency",
    "rates",
    "help",
    "stop",
    "sharing",
    "privacy_text",
    "privacy_href",
  ])("fails closed when the %s semantic marker is absent", async (marker) => {
    await expectRejected(validHtml(marker), "required visible SMS disclosure");
  });

  describe("ancestor-aware visibility", () => {
    it.each([
      ["hidden", "hidden"],
      ['hidden="false"', 'hidden="false"'],
      ["inert", "inert"],
      ['aria-hidden="true"', 'aria-hidden="true"'],
    ])("rejects a CTA with %s", async (_label, attributes) => {
      await expectRejected(
        addAttributes(validHtml(), '<a data-role="sms-cta"', attributes)
      );
    });

    it.each([
      ["hidden", "hidden"],
      ['hidden="false"', 'hidden="false"'],
      ["inert", "inert"],
      ['aria-hidden="true"', 'aria-hidden="true"'],
    ])("rejects required copy beneath a %s ancestor", async (_label, attributes) => {
      await expectRejected(
        addAttributes(validHtml(), '<main data-compliance-root="true"', attributes)
      );
    });

    it.each([
      ["HELP value", '<dd data-value="help"'],
      ["privacy anchor", '<a data-role="privacy-link"'],
    ])("rejects a directly hidden %s", async (_label, openingTag) => {
      await expectRejected(addAttributes(validHtml(), openingTag, "hidden"));
    });

    it("does not treat aria-hidden=false as concealed", async () => {
      const html = addAttributes(
        addAttributes(
          validHtml(),
          '<main data-compliance-root="true"',
          'aria-hidden="false"'
        ),
        '<a data-role="sms-cta"',
        'aria-hidden="false"'
      );
      vi.mocked(fetch).mockResolvedValue(htmlResponse(html));

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it.each([
      ["hidden", "hidden"],
      ["inert", "inert"],
      ["aria-hidden", 'aria-hidden="true"'],
      ["inline display", 'style="display:none"'],
      ["utility class", 'class="hidden"'],
    ])("rejects the entire page when <html> is concealed by %s", async (_label, attributes) => {
      await expectRejected(
        validHtml().replace("<html>", `<html ${attributes}>`)
      );
    });
  });

  describe("deterministic CSS concealment", () => {
    it.each([
      "display : none !important",
      "DISPLAY:none",
      "display/**/: none",
      "visibility: hidden",
      "visibility: collapse",
      "content-visibility: hidden",
      "opacity: 0.0",
      "color: transparent",
      "font-size: 0px",
      "transform: scale(0)",
      "clip: rect(0px, 0px, 0px, 0px)",
      "clip-path: inset(50%)",
      "height: 0; overflow: hidden",
      "width: 0px; overflow: clip",
      "display:none!important; display:block",
      "opacity: 0%",
      "opacity: var(--concealed)",
      "filter: opacity(0)",
      "-webkit-text-fill-color: transparent",
      "transform: translateX(-9999px)",
      "position: absolute; left: -9999px",
      "--hide: none; display: var(--hide)",
      "scale: 0",
      "color: rgb(0 0 0 / 0)",
      "font: 0/0 Arial",
      "position: relative; left: -9999px",
      "color: #fff0",
      "margin-left: -9999px",
    ])("rejects a compliance ancestor styled with %s", async (style) => {
      await expectRejected(
        addAttributes(
          validHtml(),
          '<main data-compliance-root="true"',
          `style="${style}"`
        )
      );
    });

    it.each([
      "hidden",
      "invisible",
      "opacity-0",
      "scale-0",
      "sr-only",
      "text-transparent",
      "md:hidden",
      "!hidden",
      "[display:none]",
      "opacity-[0]",
      "opacity-5",
      "scale-x-0",
      "scale-50",
      "scale-x-50",
      "-translate-x-full",
      "absolute -left-[9999px]",
      "truncate",
      "line-clamp-1",
      "overflow-hidden h-0",
      "overflow-clip max-w-0",
      "text-[transparent]",
      "text-[rgba(0,0,0,0)]",
      "text-[rgb(0_0_0/0)]",
      "text-[0px]",
      "text-[length:0px]",
      "text-[0px]/[0px]",
      "text-[15px]/[0px]",
      "text-sm/[0px]",
      "text-[0.001px]",
      "text-[0.001vw]",
      "text-[0.001dvw]",
      "text-[1e-9px]",
      "text-[smaller]",
      "text-[999999px]",
      "text-[1q]",
      "text-[1mm]",
      "text-[15px]/[0.001px]",
      "leading-[0.001vh]",
      "opacity-10",
      "text-white/0",
      "text-opacity-0",
      "text-white bg-white",
      "text-[#fff] bg-white",
      "text-[50%]",
      "text-[var(--brand-hidden)]",
      "text-[var(--brand-accent,transparent)]",
      "opacity-[var(--hidden)]",
      "[transform:scale(0)]",
      "md:[transform:scale(0)]",
      "absolute left-full",
      "[font-size:0px]",
      "[margin-left:-9999px]",
      "fixed -left-96",
      "h-px overflow-y-hidden",
      "w-1 overflow-x-auto",
      "max-w-[0.001px] overflow-x-scroll",
      "h-px overflow-y-auto",
      "size-1 overflow-scroll",
      "overflow-x-clip whitespace-nowrap",
      "overflow-x-hidden whitespace-pre",
      "tracking-[-9999px]",
      "tracking-[9999em]",
      "blur-[100px]",
      "blur-3xl",
      "indent-[9999px]",
      "indent-[-9999px]",
    ])("rejects a compliance ancestor with class %s", async (className) => {
      await expectRejected(
        addAttributes(
          validHtml(),
          '<main data-compliance-root="true"',
          `class="${className}"`
        )
      );
    });

    it("rejects visibility-affecting inline CSS even when its local cascade resolves visible", async () => {
      await expectRejected(
        addAttributes(
          validHtml(),
          '<main data-compliance-root="true"',
          'style="display:block!important; display:none"'
        )
      );
    });

    it("allows the narrow visibility-neutral inline style allowlist", async () => {
      const html = addAttributes(
        validHtml(),
        '<main data-compliance-root="true"',
        'style="font-family: Arial, sans-serif; font-weight: 600; text-align: left"'
      );
      vi.mocked(fetch).mockResolvedValue(htmlResponse(html));

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it("allows the fixed opaque root brand contract and approved text variables", async () => {
      const brandedRoot = validHtml().replace(
        "<html>",
        `<html style="${ROOT_BRAND_STYLE}">`
      );
      const html = addAttributes(
        brandedRoot,
        '<a data-role="privacy-link"',
        'class="text-[var(--brand-accent)] hover:text-[var(--brand-primary-active)] dark:text-[var(--brand-accent-dark)] dark:hover:text-[var(--brand-primary-soft-dark)]"'
      );
      vi.mocked(fetch).mockResolvedValue(htmlResponse(html));

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it.each([
      "--brand-unknown:#ea580c",
      "--brand-accent-extra:#c2410c",
      "--brand:#c2410c",
      "--BRAND-ACCENT:#c2410c",
      "--brand-Accent:#c2410c",
      "--brand-accent:#C2410C",
      "--brand-accent:#fff",
      "--brand-accent:#fff0",
      "--brand-accent:#ffffffff",
      "--brand-accent:transparent",
      "--brand-accent:currentColor",
      "--brand-accent:rgb(194 65 12)",
      "--brand-accent:calc(1 + 1)",
      "--brand-accent:url(https://attacker.example/hide.svg)",
      "--brand-accent-soft:var(--hidden)",
      "--brand-wash:var(--hidden)",
      "--brand-primary-alt:#f9731",
      "--brand-primary-alt-wash:#fff7e",
      "--brand-accent-rgb:255 255",
      "--brand-primary-alt-rgb:249 115 256",
      "--brand-accent-rgb:255 255 255 255",
      "--brand-accent-rgb:-1 255 255",
      "--brand-accent-rgb:255 255 256",
      "--brand-accent-rgb:255.0 255 255",
      "--brand-accent-rgb:100% 0% 0%",
      "--brand-accent-rgb:255,255,255",
      "--brand-accent-rgb:255 255 255 / 1",
      "--brand-accent-rgb:255  255 255",
      "--brand-accent-rgb:01 2 3",
      "--brand-accent:#c2410c;--brand-unknown:#ea580c",
      "--brand-accent:#c2410c;--brand-accent:transparent",
    ])("rejects a malformed or unapproved root brand declaration %s", async (style) => {
      await expectRejected(
        validHtml().replace("<html>", `<html style="${style}">`),
        "foreground-positioned"
      );
    });

    it.each([
      ["body", "<body>", "<body style=\"--brand-accent:#c2410c\">"],
      [
        "compliance root",
        '<main data-compliance-root="true">',
        '<main data-compliance-root="true" style="--brand-accent:#c2410c">',
      ],
      [
        "privacy anchor",
        '<a data-role="privacy-link"',
        '<a data-role="privacy-link" style="--brand-accent:#c2410c"',
      ],
    ])("rejects an otherwise valid brand declaration on the %s", async (_label, target, replacement) => {
      await expectRejected(validHtml().replace(target, replacement));
    });

    it("rejects a local brand override that could conceal required link text", async () => {
      await expectRejected(
        addAttributes(
          validHtml(),
          '<a data-role="privacy-link"',
          'style="--brand-accent:#ffffff" class="text-[var(--brand-accent)]"'
        )
      );
    });

    it.each([
      "text-[var(--BRAND-ACCENT)]",
      "text-[var(--brand-Accent)]",
      "text-[var(--brand-primary)]",
      "text-[var(--brand-accent-rgb)]",
      "text-[var(--brand-accent-soft)]",
      "text-[var(--brand-accent-soft-border)]",
      "text-[var(--brand-unknown)]",
      "text-[var(--brand-accent-extra)]",
      "text-[var(--brand)]",
      "text-[var(--brand-accent,transparent)]",
      "text-[var(--brand-accent,var(--brand-primary))]",
      "text-[var(_--brand-accent_)]",
      "text-[color:var(--brand-accent)]",
      "text-[var(--brand-accent)]/[0.5]",
    ])("rejects an unapproved or ambiguous brand text utility %s", async (className) => {
      await expectRejected(
        addAttributes(
          validHtml(),
          '<a data-role="privacy-link"',
          `class="${className}"`
        )
      );
    });

    it("rejects the same brand variable as both foreground and background", async () => {
      await expectRejected(
        addAttributes(
          validHtml(),
          '<a data-role="privacy-link"',
          'class="text-[var(--brand-accent)] bg-[var(--brand-accent)]"'
        )
      );
    });

    it.each([
      ['style="pointer-events: none"', "pointer-events style"],
      ['class="pointer-events-none"', "pointer-events class"],
      ["disabled", "disabled"],
      ['disabled="false"', "disabled=false"],
      ['aria-disabled="true"', "aria-disabled"],
    ])("rejects an unusable CTA with %s", async (attributes) => {
      await expectRejected(
        addAttributes(validHtml(), '<a data-role="sms-cta"', attributes)
      );
    });
  });

  describe("duplicate and fragmented content", () => {
    it("does not let a complete hidden clone repair an incomplete visible page", async () => {
      const hiddenClone = `<div hidden>${bodyContent(validHtml())}</div>`;
      const visibleIncomplete = bodyContent(validHtml("purpose"));

      await expectRejected(documentWithBody(`${hiddenClone}${visibleIncomplete}`));
    });

    it("accepts a complete visible block despite a hidden duplicate", async () => {
      const html = documentWithBody(
        `<div hidden>${bodyContent(validHtml())}</div>${bodyContent(validHtml())}`
      );
      vi.mocked(fetch).mockResolvedValue(htmlResponse(html));

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it("does not combine a visible CTA label with a hidden correct href", async () => {
      const html = appendToRoot(
        validHtml("sms_href"),
        `<a hidden href="sms:${SMS_NUMBER}">Text us at ${SMS_NUMBER}</a>`
      );
      await expectRejected(html);
    });

    it("does not associate a definition value with a different sibling block", async () => {
      const expectedHelp = escapeHtmlText(copy.disclosures.help);
      const html = validHtml()
        .replace(
          `<dd data-value="help">${expectedHelp}</dd>`,
          '<dd data-value="help">Contact support.</dd>'
        )
        .replace(
          '<dd data-value="stop">',
          `<dd>${expectedHelp}</dd><dd data-value="stop">`
        );
      await expectRejected(html);
    });
  });

  describe("attributes and link semantics", () => {
    it("does not count exact href bytes stored in an unrelated attribute", async () => {
      const html = appendToRoot(
        validHtml("sms_href"),
        `<div data-leak='href="sms:${SMS_NUMBER}"'>Text us at ${SMS_NUMBER}</div>`
      );
      await expectRejected(html);
    });

    it("does not count href and CTA text on a non-anchor element", async () => {
      const html = appendToRoot(
        validHtml("sms_href"),
        `<div href="sms:${SMS_NUMBER}">Text us at ${SMS_NUMBER}</div>`
      );
      await expectRejected(html);
    });

    it.each(["title", "data-copy", "aria-label", "value"])(
      "does not count purpose copy found only in %s",
      async (attribute) => {
        const html = appendToRoot(
          validHtml("purpose"),
          `<div ${attribute}=">${escapeHtmlText(copy.disclosures.purpose)}"></div>`
        );
        await expectRejected(html);
      }
    );

    it("does not leak text after a greater-than character inside a quoted attribute", async () => {
      const html = appendToRoot(
        validHtml("purpose"),
        `<div title=">${escapeHtmlText(copy.disclosures.purpose)}">No disclosure</div>`
      );
      await expectRejected(html);
    });

    it("does not count an aria-label as visible CTA text", async () => {
      const html = addAttributes(
        validHtml("cta_text"),
        '<a data-role="sms-cta"',
        `aria-label="Text us at ${SMS_NUMBER}"`
      );
      await expectRejected(html);
    });

    it("accepts semantic hrefs serialized with single quotes and uppercase names", async () => {
      const html = validHtml()
        .replace(
          `<a data-role="sms-cta" href="sms:${SMS_NUMBER}"`,
          `<A data-role="sms-cta" HREF='sms:${SMS_NUMBER}'`
        )
        .replace("</a>", "</A>")
        .replace(
          `<a data-role="privacy-link" href="${PRIVACY_HREF}"`,
          `<A data-role="privacy-link" HREF='${PRIVACY_HREF}'`
        )
        .replace("</a></dd>", "</A></dd>");
      vi.mocked(fetch).mockResolvedValue(htmlResponse(html));

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it("accepts browser-decoded exact href entity values", async () => {
      const encodedPrivacy = "&#47;c&#47;northstar-home-care&#47;privacy";
      const html = validHtml()
        .replace(`sms:${SMS_NUMBER}`, "sms:&#43;13175550123")
        .replace(PRIVACY_HREF, encodedPrivacy);
      vi.mocked(fetch).mockResolvedValue(htmlResponse(html));

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it.each([
      "sms:%2B13175550123",
      `sms:${SMS_NUMBER}?body=hello`,
      `sms:${SMS_NUMBER}#message`,
      `SMS:${SMS_NUMBER}`,
    ])("rejects non-canonical SMS href %s", async (href) => {
      await expectRejected(
        validHtml().replace(`href="sms:${SMS_NUMBER}"`, `href="${href}"`)
      );
    });

    it.each([
      `${APP_ORIGIN}${PRIVACY_HREF}`,
      `${PRIVACY_HREF}/`,
      `${PRIVACY_HREF}?source=sms`,
      `${PRIVACY_HREF}#mobile`,
      "/c%2Fnorthstar-home-care%2Fprivacy",
      "//outside.example.test/c/northstar-home-care/privacy",
    ])("rejects non-canonical privacy href %s", async (href) => {
      await expectRejected(
        validHtml().replace(`href="${PRIVACY_HREF}"`, `href="${href}"`)
      );
    });

    it("rejects a base element that rebases the exact relative privacy href", async () => {
      const html = validHtml().replace(
        "</head>",
        '<base href="https://outside.example.test/"></head>'
      );
      await expectRejected(html);
    });

    it("rejects page-wide inline style rules that conceal otherwise valid content", async () => {
      await expectRejected(
        validHtml().replace(
          "</head>",
          "<style>main { display: none !important; }</style></head>"
        ),
        "inline style element"
      );
    });

    it("rejects meta refresh navigation away from the compliance page", async () => {
      await expectRejected(
        validHtml().replace(
          "</head>",
          '<meta http-equiv="refresh" content="0;url=/elsewhere"></head>'
        ),
        "meta refresh"
      );
    });

    it("rejects a foreground fixed overlay that covers valid compliance content", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div class="fixed inset-0 z-50 bg-white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("does not treat a theme-conditional negative z-index as universally behind", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div class="fixed inset-0 dark:-z-10 bg-white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("does not let an inline foreground z-index override the negative decoration fence", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div class="fixed inset-0 -z-10" style="z-index: 999; background: white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("does not let a CSS-escaped z-index override the negative decoration fence", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div class="fixed inset-0 -z-10" style="z\\2d index:999;background:white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("does not treat conflicting foreground and negative z-index classes as behind", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div class="fixed inset-0 -z-10 z-50 bg-white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("does not treat a responsive foreground z-index as universally behind", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div class="fixed inset-0 -z-10 sm:z-50 bg-white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("does not let an arbitrary z-index property override the negative decoration fence", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div class="fixed inset-0 -z-10 [z-index:999] bg-white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("honors important positioning over a later normal declaration", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div style="position:fixed!important;position:static;z-index:999;inset:0;background:white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("honors an important foreground z-index over a later negative declaration", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div style="position:fixed;z-index:999!important;z-index:-10;inset:0;background:white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("rejects a relative inline-style layer that overlaps the valid page", async () => {
      await expectRejected(
        validHtml().replace(
          '<main data-compliance-root="true">',
          '<div style="position:relative;z-index:9999;height:100vh;margin-bottom:-100vh;background:white">Overlay</div><main data-compliance-root="true">'
        ),
        "foreground-positioned"
      );
    });

    it("rejects a negative-margin Tailwind layer that overlaps the valid page", async () => {
      await expectRejected(
        validHtml().replace(
          '<main data-compliance-root="true">',
          '<div class="relative z-50 h-screen -mb-[100vh] bg-white">Overlay</div><main data-compliance-root="true">'
        ),
        "foreground-positioned"
      );
    });

    it("rejects a translated foreground sibling that overlaps the valid page", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div class="relative z-50 h-screen -translate-y-full bg-white">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("rejects arbitrary-property Tailwind overlays", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<div class="[position:fixed] [inset:0] [z-index:999] [background:white]">Overlay</div></body>'
        ),
        "foreground-positioned"
      );
    });

    it("rejects a positive full translation that overlaps following content", async () => {
      await expectRejected(
        validHtml().replace(
          '<main data-compliance-root="true">',
          '<div class="relative z-50 h-[200vh] translate-y-full bg-white">Overlay</div><main data-compliance-root="true">'
        ),
        "foreground-positioned"
      );
    });

    it("rejects a positive relative offset that overlaps following content", async () => {
      await expectRejected(
        validHtml().replace(
          '<main data-compliance-root="true">',
          '<div class="relative z-50 h-96 top-96 bg-white">Overlay</div><main data-compliance-root="true">'
        ),
        "foreground-positioned"
      );
    });

    it("rejects explicit grid placement that paints a foreground sibling over the page", async () => {
      const main = bodyContent(validHtml());
      await expectRejected(
        documentWithBody(
          `<div class="grid"><div class="col-start-1 row-start-1">${main}</div><div class="col-start-1 row-start-1 z-50 bg-white">Overlay</div></div>`
        ),
        "foreground-positioned"
      );
    });

    it("rejects arbitrary grid-line shorthands that stack a foreground sibling over the page", async () => {
      const main = bodyContent(validHtml());
      await expectRejected(
        documentWithBody(
          `<div class="grid"><div class="col-[1] row-[1]">${main}</div><div class="col-[1] row-[1] z-50 bg-white">Overlay</div></div>`
        ),
        "foreground-positioned"
      );
    });

    it("rejects enlarged transform layers that cover following content", async () => {
      await expectRejected(
        validHtml().replace(
          '<main data-compliance-root="true">',
          '<div class="relative z-50 h-screen origin-top scale-[10] bg-white">Overlay</div><main data-compliance-root="true">'
        ),
        "foreground-positioned"
      );
    });

    it("rejects negative sibling spacing that pulls a foreground layer over the page", async () => {
      const main = bodyContent(validHtml());
      await expectRejected(
        documentWithBody(
          `<div class="-space-y-[200vh]"><div>${main}</div><div class="relative z-50 h-[200vh] bg-white">Overlay</div></div>`
        ),
        "foreground-positioned"
      );
    });

    it("allows a fixed decorative layer only when it is explicitly behind the page", async () => {
      const html = validHtml().replace(
        "<body>",
        '<body><div class="pointer-events-none fixed inset-0 -z-10" style="background: white"></div>'
      );
      vi.mocked(fetch).mockResolvedValue(htmlResponse(html));

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it("rejects nested anchors that move the SMS label onto the wrong browser link", async () => {
      const correctCta = `<a data-role="sms-cta" href="sms:${SMS_NUMBER}">${escapeHtmlText(`Text us at ${SMS_NUMBER}`)}</a>`;
      const smuggledCta = `<a data-role="sms-cta" href="sms:${SMS_NUMBER}"><a href="/wrong">${escapeHtmlText(`Text us at ${SMS_NUMBER}`)}</a></a>`;

      await expectRejected(
        validHtml().replace(correctCta, smuggledCta),
        "nested anchors"
      );
    });

    it("rejects nested anchors that move the privacy label onto the wrong browser link", async () => {
      const correctLink = `<a data-role="privacy-link" href="${PRIVACY_HREF}">${escapeHtmlText(copy.disclosures.privacyPolicy)}</a>`;
      const smuggledLink = `<a data-role="privacy-link" href="${PRIVACY_HREF}"><a href="/wrong">${escapeHtmlText(copy.disclosures.privacyPolicy)}</a></a>`;

      await expectRejected(
        validHtml().replace(correctLink, smuggledLink),
        "nested anchors"
      );
    });
  });

  describe("non-rendered and conditional containers", () => {
    it.each([
      "script",
      "style",
      "noscript",
      "template",
      "svg",
      "math",
      "canvas",
      "iframe",
      "object",
      "textarea",
      "select",
      "xmp",
      "noembed",
      "noframes",
      "progress",
      "meter",
    ])("does not count a complete compliance page found only in <%s>", async (tag) => {
      await expectRejected(
        documentWithBody(`<${tag}>${bodyContent(validHtml())}</${tag}>`)
      );
    });

    it("does not count compliance-looking markup after a plaintext element", async () => {
      await expectRejected(
        documentWithBody(`<plaintext>${bodyContent(validHtml())}`)
      );
    });

    it("does not count form-control values as disclosure text", async () => {
      await expectRejected(
        documentWithBody(
          `<form><input type="hidden" value="${escapeHtmlText(bodyContent(validHtml()))}"><textarea>${bodyContent(validHtml())}</textarea></form>`
        )
      );
    });

    it.each([
      ["closed details", "<details>", "</details>"],
      ["closed dialog", "<dialog>", "</dialog>"],
      ["popover", '<div popover="manual">', "</div>"],
      ["disabled ancestor", "<div disabled>", "</div>"],
    ])("does not count content in %s", async (_label, open, close) => {
      await expectRejected(
        documentWithBody(`${open}${bodyContent(validHtml())}${close}`)
      );
    });

    it("accepts otherwise eligible content in open details", async () => {
      vi.mocked(fetch).mockResolvedValue(
        htmlResponse(
          documentWithBody(
            `<details open>${bodyContent(validHtml())}</details>`
          )
        )
      );

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it("rejects named details groups because browsers force one disclosure closed", async () => {
      const complete = bodyContent(validHtml());
      await expectRejected(
        documentWithBody(
          `<details name="compliance" open>${complete}</details><details name="compliance" open>Second panel</details>`
        ),
        "named details group"
      );
    });

    it.each(["bdo", "big", "font", "marquee", "nobr", "small", "sub", "sup"])(
      "rejects legacy or compounding <%s> presentation around the disclosures",
      async (tag) => {
        await expectRejected(
          documentWithBody(`<${tag}>${bodyContent(validHtml())}</${tag}>`),
          "presentational"
        );
      }
    );

    it("does not count ruby-parenthesis fallback text as visible copy", async () => {
      await expectRejected(
        documentWithBody(`<ruby><rp>${bodyContent(validHtml())}</rp></ruby>`)
      );
    });

    it.each([
      'text="white" bgcolor="white"',
      'link="white" bgcolor="white"',
      'background="/opaque-cover.png"',
    ])(
      "rejects body presentation attributes %s whose contrast cannot be proven",
      async (attributes) => {
        await expectRejected(
          documentWithBody(bodyContent(validHtml()), attributes),
          "presentational attributes"
        );
      }
    );

    it("rejects an open dialog because the browser top layer can cover the page", async () => {
      await expectRejected(
        documentWithBody(
          `<dialog open>${bodyContent(validHtml())}</dialog>`
        ),
        "foreground-positioned"
      );
    });
  });

  describe("scripts, comments, and malformed HTML", () => {
    it("accepts a canonical Next production stylesheet link", async () => {
      const html = validHtml().replace(
        "</head>",
        '<link rel="stylesheet" href="/_next/static/css/abc123.css" precedence="next"></head>'
      );
      vi.mocked(fetch).mockResolvedValue(htmlResponse(html));

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it.each([
      'data:text/css,body%7Bdisplay%3Anone%7D',
      'https://outside.example.test/hide.css',
      '/_next/static/css/../../api/hide.css',
    ])("rejects an unverified stylesheet source %s", async (source) => {
      await expectRejected(
        validHtml().replace(
          "</head>",
          `<link rel="stylesheet" href="${source}"></head>`
        ),
        "unverified stylesheet"
      );
    });

    it.each(["system", "light"])("accepts the vetted Next static, Flight-data, and %s-default theme bootstraps", async (defaultTheme) => {
      const scripts = [
        '<script src="/_next/static/chunks/app/(public)/c/%5Bslug%5D/page-abcd1234.js" async></script>',
        '<script>self.__next_f.push([1,"serialized flight data"])</script>',
        `<script>${NEXT_THEMES_SCRIPT.replace('"class","theme","system"', `"class","theme","${defaultTheme}"`)}</script>`,
      ].join("");
      vi.mocked(fetch).mockResolvedValue(
        htmlResponse(validHtml().replace("</head>", `${scripts}</head>`))
      );

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it("rejects an inline redirect script", async () => {
      await expectRejected(
        validHtml().replace(
          "</head>",
          "<script>location.replace('/elsewhere')</script></head>"
        ),
        "executable script"
      );
    });

    it("rejects executable expressions disguised as Next Flight data", async () => {
      await expectRejected(
        validHtml().replace(
          "</head>",
          "<script>self.__next_f.push([(document.body.hidden=true)])</script></head>"
        ),
        "executable script"
      );
    });

    it("rejects traversal outside the trusted Next static script path", async () => {
      await expectRejected(
        validHtml().replace(
          "</head>",
          '<script src="/_next/static/../../api/hide.js"></script></head>'
        ),
        "executable script"
      );
    });

    it("rejects inline event handlers that mutate the visible page", async () => {
      await expectRejected(
        validHtml().replace("<body>", '<body onload="this.hidden=true">'),
        "event-handler"
      );
    });

    it("rejects active embedded documents that can mutate their parent", async () => {
      await expectRejected(
        validHtml().replace(
          "</body>",
          '<iframe srcdoc="&lt;script>parent.document.body.hidden=true&lt;/script>"></iframe></body>'
        ),
        "active embedded"
      );
    });

    it("does not let missing visible copy be repaired by Next.js script data", async () => {
      const html = validHtml("purpose").replace(
        "</body>",
        `<script>${escapeHtmlText(copy.disclosures.purpose)}</script></body>`
      );
      await expectRejected(html);
    });

    it("does not count a complete page inside a comment", async () => {
      await expectRejected(
        documentWithBody(`<!--${bodyContent(validHtml())}-->`)
      );
    });

    it.each(["script", "style", "template"])(
      "fails closed for an unclosed <%s> containing complete copy",
      async (tag) => {
        await expectRejected(
          `<!doctype html><html><head></head><body><${tag}>${bodyContent(validHtml())}</body></html>`
        );
      }
    );

    it("ignores body-shaped markup inside a head script", async () => {
      const html = `<!doctype html><html><head><script>${validHtml()}</script></head><body>Not published</body></html>`;
      await expectRejected(html);
    });

    it("keeps React separator comments from breaking quoted disclosure text", async () => {
      vi.mocked(fetch).mockResolvedValue(htmlResponse(validHtml()));
      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });
  });

  describe("document shape and inspection limits", () => {
    it("ignores matching disclosure copy outside the response body", async () => {
      const inner = bodyContent(validHtml());
      await expectRejected(
        `<!doctype html><html><head><template>${inner}</template></head><body>Not published</body></html>`
      );
    });

    it("rejects multiple document bodies", async () => {
      await expectRejected(
        `<!doctype html><html><head></head><body>${bodyContent(validHtml())}</body><body>Second body</body></html>`,
        "parse and inspect"
      );
    });

    it("rejects multiple root html elements even when the inspected root is visible", async () => {
      await expectRejected(
        `<html hidden></html>${validHtml()}`,
        "document-level html"
      );
    });

    it("rejects a frameset followed by a body that browsers ignore", async () => {
      await expectRejected(
        `<!doctype html><html><head></head><frameset><frame src="about:blank"></frameset><body>${bodyContent(validHtml())}</body></html>`,
        "frameset"
      );
    });

    it("accepts one canonical Next viewport declaration", async () => {
      const html = validHtml().replace(
        "</head>",
        '<meta name="viewport" content="width=device-width, initial-scale=1"></head>'
      );
      vi.mocked(fetch).mockResolvedValue(htmlResponse(html));

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).resolves.toBeUndefined();
    });

    it("rejects viewport metadata that shrinks mobile compliance content", async () => {
      await expectRejected(
        validHtml().replace(
          "</head>",
          '<meta name="viewport" content="width=100000, initial-scale=0.01, maximum-scale=0.01"></head>'
        ),
        "non-canonical viewport"
      );
    });

    it("rejects duplicate viewport declarations", async () => {
      await expectRejected(
        validHtml().replace(
          "</head>",
          '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="viewport" content="width=device-width, initial-scale=1"></head>'
        ),
        "multiple viewport"
      );
    });

    it("rejects browser-reparented rendering content placed in the head", async () => {
      await expectRejected(
        validHtml().replace(
          "</head>",
          "<div>Browsers move this into the body</div></head>"
        ),
        "browser-ambiguous"
      );
    });

    it("rejects a body nested beneath a non-html element", async () => {
      await expectRejected(
        `<!doctype html><html><head></head><div><body>${bodyContent(validHtml())}</body></div></html>`,
        "parse and inspect"
      );
    });

    it.each([
      ["missing body", "<!doctype html><html><head></head></html>"],
      ["body only in a comment", `<!doctype html><html><!--<body>${bodyContent(validHtml())}</body>--></html>`],
      ["body only in script text", `<!doctype html><html><script><body>${bodyContent(validHtml())}</body></script></html>`],
    ])("rejects %s", async (_label, html) => {
      await expectRejected(html, "parse and inspect");
    });

    it("rejects a response above the raw HTML size limit", async () => {
      await expectRejected("x".repeat(2_000_001), "exceeds 2000000");
    });

    it("cancels a chunked response as soon as its streamed bytes exceed the limit", async () => {
      const cancel = vi.fn();
      const chunk = new TextEncoder().encode("x".repeat(1_000_001));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
        },
        cancel,
      });
      vi.mocked(fetch).mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );

      await expect(
        verifyPublishedCompliancePage(VERIFY_ARGS)
      ).rejects.toMatchObject({
        name: "PublicCompliancePageVerificationError",
        message: expect.stringContaining("exceeds 2000000 streamed bytes"),
      });
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("rejects a DOM deeper than the inspection limit", async () => {
      const depth = 260;
      const html = documentWithBody(
        `${"<div>".repeat(depth)}${bodyContent(validHtml())}${"</div>".repeat(depth)}`
      );
      await expectRejected(html, "parse and inspect");
    });

    it("rejects a DOM larger than the node inspection limit", async () => {
      const html = documentWithBody(
        `${"<i></i>".repeat(50_001)}${bodyContent(validHtml())}`
      );
      await expectRejected(html, "parse and inspect");
    });
  });

  it.each<[string, Record<string, string>, string]>([
    [
      "attachment disposition",
      { "content-disposition": 'attachment; filename="compliance.html"' },
      "Content-Disposition",
    ],
    [
      "unknown download disposition",
      { "content-disposition": "x-download; filename=compliance.html" },
      "Content-Disposition",
    ],
    ["HTTP Refresh", { refresh: "0;url=/elsewhere" }, "HTTP Refresh"],
  ])("rejects %s browser response behavior", async (_label, headers, message) => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(validHtml(), {
        status: 200,
        headers: { "content-type": "text/html", ...headers },
      })
    );

    await expect(verifyPublishedCompliancePage(VERIFY_ARGS)).rejects.toMatchObject({
      name: "PublicCompliancePageVerificationError",
      message: expect.stringContaining(message),
    });
  });

  it.each([
    ["non-200 status", htmlResponse("not found", 404, "text/html"), "Expected HTTP 200"],
    ["non-HTML content", htmlResponse("plain text", 200, "text/plain"), "Expected text/html"],
  ])("fails closed for %s", async (_label, response, message) => {
    vi.mocked(fetch).mockResolvedValue(response);

    await expect(verifyPublishedCompliancePage(VERIFY_ARGS)).rejects.toMatchObject({
      name: "PublicCompliancePageVerificationError",
      message: expect.stringContaining(message),
    });
  });

  it("wraps network failures as verification errors", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network unavailable"));

    await expect(verifyPublishedCompliancePage(VERIFY_ARGS)).rejects.toMatchObject({
      name: "PublicCompliancePageVerificationError",
      pageUrl: PAGE_URL,
      message: expect.stringContaining("Could not fetch"),
    });
  });

  it("wraps response-body read failures as verification errors", async () => {
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: vi.fn().mockRejectedValue(new Error("body read failed")),
    } as unknown as Response);

    await expect(verifyPublishedCompliancePage(VERIFY_ARGS)).rejects.toMatchObject({
      name: "PublicCompliancePageVerificationError",
      message: expect.stringContaining("Could not read"),
    });
  });
});
