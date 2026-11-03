import "server-only";

import { createHash } from "node:crypto";
import { Parser, parseDocument } from "htmlparser2";
import { buildSmsComplianceCopy } from "@/lib/messaging/complianceCopy";
import type { Language } from "@/types/database";
import { buildBusinessLandingUrl } from "./legalUrls";

const PUBLIC_COMPLIANCE_PAGE_TIMEOUT_MS = 10_000;
const PUBLIC_COMPLIANCE_PAGE_MAX_HTML_LENGTH = 2_000_000;
const PUBLIC_COMPLIANCE_PAGE_MAX_DOM_NODES = 50_000;
const PUBLIC_COMPLIANCE_PAGE_MAX_DOM_DEPTH = 256;
const PUBLIC_COMPLIANCE_PAGE_MAX_DERIVED_TEXT_LENGTH = 2_200_000;
const VETTED_NEXT_THEMES_BOOTSTRAP_SHA256 = new Set([
  // Light-default bootstraps (production build and direct server render).
  "2fcc63a7b7e5aa35b4459ca209e3390472a9fdb5951b695483adb3b6516ddc33",
  "bd0b177340f526f609edc7de2b397518ab2df04b53c3bf82bb539ab697920143",
  // Retain the system-default variants for pages served during rollout.
  // next build production-minified output (Next 14.2.35).
  "c9afcb6ed47807709be72af67988b6e04600a8222877f3bbac307ffb0799c080",
  // RootLayout direct server render used by the integration test
  // (next-themes 0.4.6, before Next's production minification).
  "71df87a674ac2da133d6529604d9fe93ec4e7b59b6a796607e3a3236f1f2f5e5",
]);

const NON_RENDERED_ELEMENTS = new Set([
  "area",
  "audio",
  "base",
  "canvas",
  "datalist",
  "embed",
  "head",
  "iframe",
  "input",
  "link",
  "map",
  "math",
  "meta",
  "meter",
  "noscript",
  "noembed",
  "noframes",
  "object",
  "optgroup",
  "option",
  "plaintext",
  "progress",
  "rp",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
  "xmp",
]);

const HIDDEN_UTILITY_CLASSES = new Set([
  "collapse",
  "hidden",
  "invisible",
  "opacity-0",
  "pointer-events-none",
  "scale-0",
  "sr-only",
  "text-transparent",
]);

const SAFE_INLINE_STYLE_PROPERTIES = new Set([
  "font-family",
  "font-style",
  "font-weight",
  "text-align",
  "text-transform",
]);

// RootLayout emits only this fixed palette contract. These properties affect
// color decoration, never layout or visibility, and their values are validated
// again from the fetched HTML before the compliance DOM is accepted.
const BRAND_HEX_INLINE_STYLE_PROPERTIES = new Set([
  "--brand-primary",
  "--brand-primary-hover",
  "--brand-primary-active",
  "--brand-accent",
  "--brand-primary-dark",
  "--brand-primary-hover-dark",
  "--brand-primary-active-dark",
  "--brand-accent-dark",
  "--brand-accent-soft",
  "--brand-accent-soft-border",
  "--brand-accent-soft-dark",
  "--brand-primary-soft-dark",
  "--brand-tint-strong",
  "--brand-tint",
  "--brand-text-soft-dark",
  "--brand-surface-dark",
  "--brand-selection-border",
  "--brand-wash-faint",
  "--brand-wash",
  "--brand-border-soft",
  "--brand-border-strong",
  "--brand-calendar-border",
  "--brand-calendar-wash",
  "--brand-calendar-muted",
  "--brand-calendar-accent",
  "--brand-primary-alt",
  "--brand-primary-alt-wash",
]);

const BRAND_RGB_INLINE_STYLE_PROPERTIES = new Set([
  "--brand-primary-rgb",
  "--brand-primary-hover-rgb",
  "--brand-primary-active-rgb",
  "--brand-accent-rgb",
  "--brand-primary-dark-rgb",
  "--brand-primary-hover-dark-rgb",
  "--brand-primary-active-dark-rgb",
  "--brand-accent-dark-rgb",
  "--brand-primary-alt-rgb",
]);

const READABLE_BRAND_TEXT_VARIABLES = new Set([
  "--brand-primary-active",
  "--brand-accent",
  "--brand-accent-dark",
  "--brand-primary-soft-dark",
]);

const ALLOWED_HEAD_ELEMENTS = new Set([
  "base",
  "head",
  "link",
  "meta",
  "noscript",
  "script",
  "template",
  "title",
]);

const ACTIVE_EMBEDDED_ELEMENTS = new Set([
  "embed",
  "iframe",
  "object",
  "portal",
]);

const UNVERIFIABLE_PRESENTATIONAL_ELEMENTS = new Set([
  "bdo",
  "big",
  "font",
  "marquee",
  "nobr",
  "small",
  "sub",
  "sup",
]);

const UNVERIFIABLE_BODY_ATTRIBUTES = new Set([
  "alink",
  "background",
  "bgcolor",
  "link",
  "text",
  "vlink",
]);

interface DomNode {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
  parent?: DomNode | null;
}

interface DomElement extends DomNode {
  name: string;
  attribs: Record<string, string>;
  children: DomNode[];
}

interface VisibleDom {
  visibleText: string;
  elementsByTag: Map<string, DomElement[]>;
  rangeByElement: Map<DomElement, { start: number; end: number }>;
  definitionPairs: Array<{ term: DomElement; definition: DomElement }>;
  normalizedTextByElement: Map<DomElement, string>;
  inspectedTextLength: number;
}

interface ParsedInlineStyle {
  values: Map<string, string>;
  hasAmbiguousPositioningCascade: boolean;
}

export class PublicCompliancePageVerificationError extends Error {
  readonly pageUrl: string;

  constructor(pageUrl: string, reason: string, options?: { cause?: unknown }) {
    super(
      `[registration:publicCompliancePage] ${reason} (${pageUrl})`,
      options
    );
    this.name = "PublicCompliancePageVerificationError";
    this.pageUrl = pageUrl;
  }
}

/**
 * Verify the public, server-rendered opt-in surface before a campaign can be
 * submitted. This deliberately fetches the deployed URL instead of trusting
 * local database state: the campaign message flow says the number is
 * published there, so the parsed server-rendered DOM a carrier reviewer
 * receives is the source of truth. This proves DOM eligibility and common
 * deterministic concealment states; it does not claim to compute arbitrary
 * external stylesheet/media-query visibility.
 */
export async function verifyPublishedCompliancePage({
  slug,
  businessName,
  smsPhoneNumber,
  language,
}: {
  slug: string;
  businessName: string;
  smsPhoneNumber: string;
  language?: Language | null;
}): Promise<void> {
  const pageUrl = buildBusinessLandingUrl(slug);

  let response: Response;
  try {
    response = await fetch(pageUrl, {
      cache: "no-store",
      headers: {
        accept: "text/html",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal: AbortSignal.timeout(PUBLIC_COMPLIANCE_PAGE_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      "Could not fetch the public compliance page",
      { cause }
    );
  }

  if (response.status !== 200) {
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      `Expected HTTP 200 but received ${response.status}`
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^text\/html(?:\s*;|$)/.test(contentType.trim())) {
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      `Expected text/html but received ${contentType || "no content type"}`
    );
  }

  const contentDisposition =
    response.headers.get("content-disposition")?.toLowerCase() ?? "";
  if (contentDisposition.trim() !== "") {
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      "Public compliance page sends Content-Disposition instead of relying on rendered HTML"
    );
  }
  if (response.headers.has("refresh")) {
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      "Public compliance page sends an HTTP Refresh navigation header"
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > PUBLIC_COMPLIANCE_PAGE_MAX_HTML_LENGTH
  ) {
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      `Public compliance page declares more than ${PUBLIC_COMPLIANCE_PAGE_MAX_HTML_LENGTH} bytes`
    );
  }

  let html: string;
  try {
    html = await readResponseTextWithLimit(response);
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      `Could not read the public compliance page response${detail}`,
      { cause }
    );
  }

  if (html.length > PUBLIC_COMPLIANCE_PAGE_MAX_HTML_LENGTH) {
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      `Public compliance page exceeds ${PUBLIC_COMPLIANCE_PAGE_MAX_HTML_LENGTH} characters`
    );
  }

  let visibleDom: VisibleDom;
  try {
    preflightHtmlComplexity(html);
    const documentNode = parseDocument(html, {
      decodeEntities: true,
      lowerCaseAttributeNames: true,
      lowerCaseTags: true,
    }) as unknown as DomNode;
    const body = requireSingleDocumentBody(documentNode);
    visibleDom = collectVisibleDom(body);
  } catch (cause) {
    if (cause instanceof PublicCompliancePageVerificationError) throw cause;
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      `Could not parse and inspect the server-rendered compliance DOM${detail}`,
      { cause }
    );
  }

  const privacyHref = `/c/${slug}/privacy`;
  const expectedCopy = buildSmsComplianceCopy({
    business: { name: businessName, email: null, phone_number: null },
    smsPhoneNumber,
    smsEntryPoint: `this page (/c/${slug})`,
    privacyUrl: privacyHref,
    language,
  });

  const smsAnchor = findVisibleAnchor(
    visibleDom,
    `sms:${smsPhoneNumber}`,
    `Text us at ${smsPhoneNumber}`
  );
  const smsSection = smsAnchor
    ? nearestVisibleAncestor(visibleDom, smsAnchor, "section")
    : null;

  const requiredChecks: Array<[name: string, present: boolean]> = [
    ["sms_cta", smsAnchor !== null],
    [
      "sms_purpose",
      smsSection !== null &&
        hasVisibleHeadingWithin(visibleDom, smsSection, "SMS customer care") &&
        elementContainsText(
          visibleDom,
          smsSection,
          expectedCopy.disclosures.purpose
        ),
    ],
    [
      "opt_in_introduction",
      hasVisibleHeadingBlock(
        visibleDom,
        "SMS opt-in and program details",
        [expectedCopy.optInPaths.introduction]
      ),
    ],
    [
      "text_message_opt_in",
      hasVisibleHeadingBlock(visibleDom, "Text-message opt-in", [
        expectedCopy.optInPaths.inboundSms,
        "Confirmation SMS",
        `“${expectedCopy.confirmationSms}”`,
      ]),
    ],
    [
      "voicemail_opt_in",
      hasVisibleHeadingBlock(visibleDom, "Voicemail opt-in", [
        expectedCopy.optInPaths.voicemail,
        expectedCopy.optInPaths.callForwarding,
        "What callers hear before leaving a message",
        `“${expectedCopy.voicemailGreeting}”`,
      ]),
    ],
    [
      "message_frequency",
      hasVisibleDefinition(
        visibleDom,
        "Message frequency",
        expectedCopy.disclosures.frequency
      ),
    ],
    [
      "message_and_data_rates",
      hasVisibleDefinition(
        visibleDom,
        "Message and data rates",
        expectedCopy.disclosures.rates
      ),
    ],
    [
      "help",
      hasVisibleDefinition(
        visibleDom,
        "HELP",
        expectedCopy.disclosures.help
      ),
    ],
    [
      "stop",
      hasVisibleDefinition(
        visibleDom,
        "STOP",
        expectedCopy.disclosures.stop
      ),
    ],
    [
      "mobile_information_sharing",
      hasVisibleDefinition(
        visibleDom,
        "Mobile information sharing",
        expectedCopy.disclosures.mobileInformationSharing
      ),
    ],
    [
      "privacy_policy",
      hasVisibleDefinition(
        visibleDom,
        "Privacy Policy",
        expectedCopy.disclosures.privacyPolicy,
        {
          href: privacyHref,
          anchorText: expectedCopy.disclosures.privacyPolicy,
        }
      ),
    ],
  ];
  const missingChecks = requiredChecks
    .filter(([, present]) => !present)
    .map(([name]) => name);

  if (missingChecks.length > 0) {
    throw new PublicCompliancePageVerificationError(
      pageUrl,
      `Parsed DOM is missing or concealing ${missingChecks.length} required visible SMS disclosure marker(s): ${missingChecks.join(", ")}`
    );
  }
}

function isElement(node: DomNode | null | undefined): node is DomElement {
  return (
    !!node &&
    typeof node.name === "string" &&
    !!node.attribs &&
    Array.isArray(node.children)
  );
}

async function readResponseTextWithLimit(response: Response): Promise<string> {
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let receivedBytes = 0;
  let decodedCharacters = 0;

  const append = (chunk: string): void => {
    decodedCharacters += chunk.length;
    if (decodedCharacters > PUBLIC_COMPLIANCE_PAGE_MAX_HTML_LENGTH) {
      throw new Error(
        `Public compliance page exceeds ${PUBLIC_COMPLIANCE_PAGE_MAX_HTML_LENGTH} characters`
      );
    }
    chunks.push(chunk);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > PUBLIC_COMPLIANCE_PAGE_MAX_HTML_LENGTH) {
        throw new Error(
          `Public compliance page exceeds ${PUBLIC_COMPLIANCE_PAGE_MAX_HTML_LENGTH} streamed bytes`
        );
      }
      append(decoder.decode(value, { stream: true }));
    }
    append(decoder.decode());
    return chunks.join("");
  } catch (cause) {
    try {
      await reader.cancel(cause);
    } catch {
      // Preserve the original read/limit error if cancellation also fails.
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

function preflightHtmlComplexity(html: string): void {
  let nodeCount = 1;
  let depth = 0;

  const countNode = (): void => {
    nodeCount += 1;
    if (nodeCount > PUBLIC_COMPLIANCE_PAGE_MAX_DOM_NODES) {
      throw new Error("Compliance DOM exceeds inspection limits");
    }
  };

  const parser = new Parser(
    {
      onopentag() {
        countNode();
        depth += 1;
        if (depth > PUBLIC_COMPLIANCE_PAGE_MAX_DOM_DEPTH) {
          throw new Error("Compliance DOM exceeds inspection limits");
        }
      },
      onclosetag() {
        depth = Math.max(0, depth - 1);
      },
      ontext(text) {
        if (text.length > 0) countNode();
      },
      oncomment() {
        countNode();
      },
      onprocessinginstruction() {
        countNode();
      },
    },
    {
      decodeEntities: false,
      lowerCaseAttributeNames: true,
      lowerCaseTags: true,
    }
  );

  parser.write(html);
  parser.end();
}

function requireSingleDocumentBody(documentNode: DomNode): DomElement {
  const htmlElements: DomElement[] = [];
  const headElements: DomElement[] = [];
  const bodies: DomElement[] = [];
  const viewportMetas: DomElement[] = [];
  let hasBaseElement = false;
  let visited = 0;
  const stack: Array<{
    node: DomNode;
    depth: number;
    insideAnchor: boolean;
  }> = [
    { node: documentNode, depth: 0, insideAnchor: false },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    visited += 1;
    if (
      visited > PUBLIC_COMPLIANCE_PAGE_MAX_DOM_NODES ||
      current.depth > PUBLIC_COMPLIANCE_PAGE_MAX_DOM_DEPTH
    ) {
      throw new Error("Compliance DOM exceeds inspection limits");
    }

    const currentElement = isElement(current.node) ? current.node : null;
    if (
      currentElement &&
      Object.keys(currentElement.attribs).some((attribute) =>
        /^on[a-z]/i.test(attribute)
      )
    ) {
      throw new Error(
        "Parsed HTML contains an executable event-handler attribute"
      );
    }
    if (currentElement && ACTIVE_EMBEDDED_ELEMENTS.has(currentElement.name)) {
      throw new Error(
        `Parsed HTML contains active embedded <${currentElement.name}> content`
      );
    }
    if (
      currentElement &&
      UNVERIFIABLE_PRESENTATIONAL_ELEMENTS.has(currentElement.name)
    ) {
      throw new Error(
        `Parsed HTML contains presentational <${currentElement.name}> content whose visibility cannot be verified`
      );
    }
    if (
      currentElement?.name === "body" &&
      Object.keys(currentElement.attribs).some((attribute) =>
        UNVERIFIABLE_BODY_ATTRIBUTES.has(attribute)
      )
    ) {
      throw new Error(
        "Parsed body contains legacy presentational attributes whose contrast cannot be verified"
      );
    }
    if (
      currentElement?.name === "details" &&
      Object.prototype.hasOwnProperty.call(currentElement.attribs, "name")
    ) {
      throw new Error(
        "Parsed HTML contains a named details group whose mutually exclusive open state cannot be verified"
      );
    }
    if (currentElement?.name === "html") htmlElements.push(currentElement);
    if (currentElement?.name === "head") headElements.push(currentElement);
    if (currentElement?.name === "body") bodies.push(currentElement);
    if (currentElement?.name === "base") hasBaseElement = true;
    if (
      currentElement?.name === "meta" &&
      currentElement.attribs.name?.trim().toLowerCase() === "viewport"
    ) {
      viewportMetas.push(currentElement);
    }
    if (currentElement?.name === "style") {
      throw new Error(
        "Parsed HTML contains an inline style element whose page-wide visibility cannot be verified"
      );
    }
    if (currentElement?.name === "link") {
      validateLinkElement(currentElement);
    }
    if (currentElement?.name === "script" && !isAllowedFrameworkScript(currentElement)) {
      throw new Error(
        "Parsed HTML contains executable script outside the verified Next.js runtime boundary"
      );
    }
    if (
      currentElement?.name === "meta" &&
      currentElement.attribs["http-equiv"]?.trim().toLowerCase() === "refresh"
    ) {
      throw new Error(
        "Parsed HTML contains a meta refresh that can navigate reviewers away"
      );
    }
    if (currentElement?.name === "frameset") {
      throw new Error(
        "Parsed HTML contains a frameset that makes the browser body ambiguous"
      );
    }
    if (currentElement?.name === "a" && current.insideAnchor) {
      throw new Error(
        "Parsed HTML contains nested anchors with browser-ambiguous link targets"
      );
    }
    if (
      currentElement &&
      elementMayOccludeCompliancePage(
        currentElement,
        currentElement.name === "html" && currentElement.parent === documentNode
      )
    ) {
      throw new Error(
        "Parsed HTML contains a foreground-positioned element that may cover the compliance page"
      );
    }
    const insideAnchor =
      current.insideAnchor || currentElement?.name === "a";
    for (const child of current.node.children ?? []) {
      stack.push({
        node: child,
        depth: current.depth + 1,
        insideAnchor,
      });
    }
  }

  if (hasBaseElement) {
    throw new Error(
      "Parsed HTML contains a base element that makes link targets ambiguous"
    );
  }
  const html = htmlElements[0];
  const head = headElements[0];
  const body = bodies[0];
  if (
    htmlElements.length !== 1 ||
    headElements.length !== 1 ||
    bodies.length !== 1 ||
    html.parent !== documentNode ||
    head.parent !== html ||
    body.parent !== html
  ) {
    throw new Error(
      "Parsed HTML does not contain exactly one document-level html element with direct-child head and body elements"
    );
  }
  validateHeadSubtree(head);
  validateViewportMetadata(viewportMetas);
  return body;
}

function validateHeadSubtree(head: DomElement): void {
  const stack = [...head.children];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    if (isElement(node)) {
      if (!ALLOWED_HEAD_ELEMENTS.has(node.name)) {
        throw new Error(
          `Parsed head contains browser-ambiguous <${node.name}> content`
        );
      }
      stack.push(...node.children);
    }
  }
}

function validateViewportMetadata(viewportMetas: DomElement[]): void {
  if (viewportMetas.length === 0) return;
  if (viewportMetas.length !== 1) {
    throw new Error("Parsed HTML contains multiple viewport declarations");
  }
  const directives = (viewportMetas[0].attribs.content ?? "")
    .toLowerCase()
    .split(",")
    .map((directive) => directive.replace(/\s+/g, "").trim())
    .filter(Boolean)
    .sort();
  if (
    directives.length !== 2 ||
    directives[0] !== "initial-scale=1" ||
    directives[1] !== "width=device-width"
  ) {
    throw new Error(
      "Parsed HTML contains a non-canonical viewport that may shrink compliance content"
    );
  }
}

function validateLinkElement(link: DomElement): void {
  const relationships = (link.attribs.rel ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!relationships.includes("stylesheet")) return;

  const source = link.attribs.href?.trim() ?? "";
  if (!isCanonicalNextStaticStylesheetSource(source)) {
    throw new Error(
      "Parsed HTML links an unverified stylesheet that may conceal compliance content"
    );
  }
}

function isAllowedFrameworkScript(script: DomElement): boolean {
  const type = script.attribs.type?.trim().toLowerCase() ?? "";
  if (["application/json", "application/ld+json"].includes(type)) return true;

  const source = script.attribs.src?.trim();
  if (source) {
    return isCanonicalNextStaticScriptSource(source);
  }

  const scriptText = script.children
    .filter((child) => child.type === "text")
    .map((child) => child.data ?? "")
    .join("")
    .trim();
  if (!scriptText) return true;
  if (isValidNextFlightBootstrap(scriptText)) return true;
  return VETTED_NEXT_THEMES_BOOTSTRAP_SHA256.has(
    createHash("sha256").update(scriptText).digest("hex")
  );
}

function isCanonicalNextStaticScriptSource(source: string): boolean {
  const rawPath = source.split("?", 1)[0];
  if (
    !source.startsWith("/_next/static/") ||
    source.includes("#") ||
    /%2e|%2f|%5c|\\/i.test(source) ||
    rawPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return false;
  }
  try {
    const parsed = new URL(source, "https://compliance.invalid");
    return (
      parsed.origin === "https://compliance.invalid" &&
      parsed.pathname.startsWith("/_next/static/") &&
      parsed.pathname.endsWith(".js") &&
      !parsed.pathname.split("/").some((segment) => segment === "..")
    );
  } catch {
    return false;
  }
}

function isCanonicalNextStaticStylesheetSource(source: string): boolean {
  const rawPath = source.split("?", 1)[0];
  if (
    !source.startsWith("/_next/static/css/") ||
    source.includes("#") ||
    /%2e|%2f|%5c|\\/i.test(source) ||
    rawPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return false;
  }
  try {
    const parsed = new URL(source, "https://compliance.invalid");
    return (
      parsed.origin === "https://compliance.invalid" &&
      parsed.pathname.startsWith("/_next/static/css/") &&
      parsed.pathname.endsWith(".css") &&
      !parsed.pathname.split("/").some((segment) => segment === "..")
    );
  } catch {
    return false;
  }
}

function isValidNextFlightBootstrap(scriptText: string): boolean {
  if (
    /^\(self\.__next_f=self\.__next_f\|\|\[\]\)\.push\(\[0\]\);self\.__next_f\.push\(\[2,null\]\)\s*;?$/.test(
      scriptText
    )
  ) {
    return true;
  }

  const match = scriptText.match(
    /^self\.__next_f\.push\((\[[\s\S]*\])\)\s*;?$/
  );
  if (!match) return false;
  try {
    const payload: unknown = JSON.parse(match[1]);
    if (!Array.isArray(payload)) return false;
    return (
      (payload.length === 2 &&
        payload[0] === 1 &&
        typeof payload[1] === "string") ||
      (payload.length === 2 && payload[0] === 2 && payload[1] === null) ||
      (payload.length === 1 && payload[0] === 0)
    );
  } catch {
    return false;
  }
}

function elementMayOccludeCompliancePage(
  element: DomElement,
  allowRootBrandProperties = false
): boolean {
  if (
    element.name === "dialog" &&
    Object.prototype.hasOwnProperty.call(element.attribs, "open")
  ) {
    return true;
  }

  const classTokens = (element.attribs.class ?? "")
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const utilities = classTokens.map(tailwindUtilityFromToken);
  const parsedInlineStyle = parseInlineStyleDeclarations(
    element.attribs.style ?? ""
  );
  const inlineDeclarations = parsedInlineStyle.values;
  const zIndexTokens = classTokens.filter((token) =>
    isZIndexUtility(tailwindUtilityFromToken(token))
  );
  const classZIndexIsUnambiguouslyNegative =
    zIndexTokens.length > 0 &&
    zIndexTokens.every((token) => {
      const normalizedToken = token.replace(/^!/, "");
      return (
        normalizedToken === tailwindUtilityFromToken(token) &&
        isNegativeZIndexUtility(normalizedToken)
      );
    });
  const inlineZIndex = inlineDeclarations.get("z-index");
  const unconditionallyBehind =
    inlineZIndex === undefined
      ? classZIndexIsUnambiguouslyNegative
      : isNegativeCssNumber(inlineZIndex) &&
        (zIndexTokens.length === 0 || classZIndexIsUnambiguouslyNegative);

  const classPositionsInForeground =
    utilities.some((utility) =>
      ["absolute", "fixed", "sticky"].includes(utility) ||
      /^\[position:(?:absolute|fixed|sticky)\]$/.test(utility)
    ) && !unconditionallyBehind;
  const inlinePosition = inlineDeclarations.get("position");
  const inlinePositionsInForeground =
    inlinePosition !== undefined &&
    ["absolute", "fixed", "sticky"].includes(inlinePosition) &&
    !unconditionallyBehind;

  const unsafeInlineStyleInForeground =
    (element.attribs.style ?? "").trim() !== "" &&
    parsedInlineStyleSuppresses(parsedInlineStyle, allowRootBrandProperties) &&
    !unconditionallyBehind;
  const overlappingUtilityInForeground =
    utilities.some(
      (utility) =>
        /^-(?:m[trblxy]?|translate-[xy]|left|right|top|bottom|inset(?:-[xy])?)-/.test(
          utility
        ) ||
        /^-space-[xy]-/.test(utility) ||
        /^space-[xy]-\[-/.test(utility) ||
        /^(?:translate-[xy]|left|right|top|bottom|inset(?:-[xy])?)-\[-/.test(
          utility
        ) ||
        /^-?translate-[xy]-(?:full|\[)/.test(utility) ||
        /^(?:left|right|top|bottom|inset(?:-[xy])?)-(?:full|\[)/.test(
          utility
        ) ||
        /^-?translate-[xy]-(?!0(?:\.0+)?$)/.test(utility) ||
        /^-?(?:left|right|top|bottom|inset(?:-[xy])?)-(?!0(?:\.0+)?$|auto$)/.test(
          utility
        ) ||
        /^(?:col|row)-(?:start|end)-(?!auto$)/.test(
          utility
        ) ||
        /^(?:col|row)-\[/.test(utility) ||
        /^-?scale(?:-[xy])?-(?!100$)/.test(utility) ||
        /^-?rotate-(?!0$)/.test(utility) ||
        /^-?skew-[xy]-/.test(utility)
    ) && !unconditionallyBehind;
  const arbitraryPropertyInForeground =
    utilities.some((utility) => /^\[[^\]]+:/.test(utility)) &&
    !unconditionallyBehind;

  return (
    classPositionsInForeground ||
    inlinePositionsInForeground ||
    parsedInlineStyle.hasAmbiguousPositioningCascade ||
    unsafeInlineStyleInForeground ||
    overlappingUtilityInForeground ||
    arbitraryPropertyInForeground
  );
}

function isZIndexUtility(utility: string): boolean {
  return /^(?:-z-|z-(?:auto|\[|\d)|\[z-index:)/.test(utility);
}

function isNegativeZIndexUtility(utility: string): boolean {
  return (
    /^-z-[1-9]\d*$/.test(utility) ||
    /^z-\[-(?:[1-9]\d*)(?:\.\d+)?\]$/.test(utility)
  );
}

function isNegativeCssNumber(value: string | undefined): boolean {
  if (!value || !/^-\d+(?:\.\d+)?$/.test(value)) return false;
  return Number(value) < 0;
}

function collectVisibleDom(body: DomElement): VisibleDom {
  const textChunks: string[] = [];
  const elementsByTag = new Map<string, DomElement[]>();
  const rangeByElement = new Map<
    DomElement,
    { start: number; end: number }
  >();
  const childrenByParent = new Map<DomElement, DomElement[]>();
  let derivedTextLength = 0;
  let visited = 0;

  const emptyDom = (): VisibleDom => ({
    visibleText: "",
    elementsByTag,
    rangeByElement,
    definitionPairs: [],
    normalizedTextByElement: new Map(),
    inspectedTextLength: 0,
  });

  const appendText = (text: string): void => {
    derivedTextLength += text.length;
    if (derivedTextLength > PUBLIC_COMPLIANCE_PAGE_MAX_DERIVED_TEXT_LENGTH) {
      throw new Error("Compliance DOM derived text exceeds inspection limits");
    }
    textChunks.push(text);
  };

  // `<html>` is outside the body walk but still controls whether the entire
  // document is rendered. A hidden root must make every body marker ineligible.
  let documentAncestor = body.parent ?? null;
  while (documentAncestor) {
    if (
      isElement(documentAncestor) &&
      isSuppressedElement(
        documentAncestor,
        documentAncestor === body.parent && documentAncestor.name === "html"
      )
    ) {
      return emptyDom();
    }
    documentAncestor = documentAncestor.parent ?? null;
  }

  const visit = (node: DomNode, depth: number): void => {
    visited += 1;
    if (
      visited > PUBLIC_COMPLIANCE_PAGE_MAX_DOM_NODES ||
      depth > PUBLIC_COMPLIANCE_PAGE_MAX_DOM_DEPTH
    ) {
      throw new Error("Compliance DOM exceeds inspection limits");
    }
    if (node.type === "text") {
      appendText(node.data ?? "");
      return;
    }
    if (!isElement(node) || isSuppressedElement(node)) return;

    const start = derivedTextLength;
    // Boundaries preserve the visible separation JSX elements create while
    // keeping adjacent React text/comment/text sequences intact.
    appendText(" ");
    for (const child of node.children ?? []) visit(child, depth + 1);
    appendText(" ");
    rangeByElement.set(node, { start, end: derivedTextLength });

    const taggedElements = elementsByTag.get(node.name) ?? [];
    taggedElements.push(node);
    elementsByTag.set(node.name, taggedElements);

    if (isElement(node.parent) && rangeByElement.has(node.parent) === false) {
      // The parent is indexed after its children. Build its direct visible
      // child list now so definition pairing stays linear after traversal.
      const siblings = childrenByParent.get(node.parent) ?? [];
      siblings.push(node);
      childrenByParent.set(node.parent, siblings);
    }
  };

  visit(body, 0);

  const definitionPairs: VisibleDom["definitionPairs"] = [];
  childrenByParent.forEach((children) => {
    for (let index = 0; index + 1 < children.length; index += 1) {
      const term = children[index];
      const definition = children[index + 1];
      if (term.name === "dt" && definition.name === "dd") {
        definitionPairs.push({ term, definition });
      }
    }
  });

  return {
    visibleText: textChunks.join(""),
    elementsByTag,
    rangeByElement,
    definitionPairs,
    normalizedTextByElement: new Map(),
    inspectedTextLength: 0,
  };
}

function isSuppressedElement(
  element: DomElement,
  allowRootBrandProperties = false
): boolean {
  const tag = element.name;
  const attributes = element.attribs;
  if (NON_RENDERED_ELEMENTS.has(tag)) return true;
  if (
    Object.prototype.hasOwnProperty.call(attributes, "hidden") ||
    Object.prototype.hasOwnProperty.call(attributes, "inert") ||
    Object.prototype.hasOwnProperty.call(attributes, "popover") ||
    Object.prototype.hasOwnProperty.call(attributes, "disabled")
  ) {
    return true;
  }
  if (
    attributes["aria-hidden"]?.trim().toLowerCase() === "true" ||
    attributes["aria-disabled"]?.trim().toLowerCase() === "true"
  ) {
    return true;
  }
  if (
    (tag === "dialog" || tag === "details") &&
    !Object.prototype.hasOwnProperty.call(attributes, "open")
  ) {
    return true;
  }
  return (
    inlineStyleSuppresses(
      attributes.style ?? "",
      allowRootBrandProperties
    ) ||
    utilityClassesSuppress(attributes.class ?? "")
  );
}

function inlineStyleSuppresses(
  style: string,
  allowRootBrandProperties = false
): boolean {
  if (!style.trim()) return false;
  return parsedInlineStyleSuppresses(
    parseInlineStyleDeclarations(style),
    allowRootBrandProperties
  );
}

function parsedInlineStyleSuppresses(
  style: ParsedInlineStyle,
  allowRootBrandProperties = false
): boolean {
  return Array.from(style.values.entries()).some(
    ([property, value]) =>
      !isSafeInlineStyleDeclaration(
        property,
        value,
        allowRootBrandProperties
      )
  );
}

function isSafeInlineStyleDeclaration(
  property: string,
  value: string,
  allowRootBrandProperties: boolean
): boolean {
  if (SAFE_INLINE_STYLE_PROPERTIES.has(property)) return true;
  if (!allowRootBrandProperties) return false;
  if (BRAND_HEX_INLINE_STYLE_PROPERTIES.has(property)) {
    return /^#[0-9a-f]{6}$/.test(value);
  }
  if (BRAND_RGB_INLINE_STYLE_PROPERTIES.has(property)) {
    const channels = value.match(
      /^((?:0|[1-9]\d{0,2})) ((?:0|[1-9]\d{0,2})) ((?:0|[1-9]\d{0,2}))$/
    );
    return (
      channels !== null &&
      channels.slice(1).every((channel) => Number(channel) <= 255)
    );
  }
  return false;
}

function parseInlineStyleDeclarations(style: string): ParsedInlineStyle {
  const declarationsByProperty = new Map<
    string,
    { value: string; important: boolean }
  >();
  let hasAmbiguousPositioningCascade = false;
  if (/\\|[\u0000-\u001f\u007f]/.test(style)) {
    return {
      values: new Map([["__invalid_inline_declaration__", style]]),
      hasAmbiguousPositioningCascade: true,
    };
  }
  const withoutComments = style.replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = withoutComments
    .split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean);

  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 1) {
      declarationsByProperty.set("__invalid_inline_declaration__", {
        value: declaration,
        important: false,
      });
      continue;
    }
    const rawProperty = declaration.slice(0, separator).trim();
    const isCustomProperty = rawProperty.startsWith("--");
    const property = isCustomProperty
      ? rawProperty
      : rawProperty.toLowerCase();
    const rawValue = declaration.slice(separator + 1).trim();
    const important = /!\s*important\s*$/i.test(rawValue);
    const valueWithoutImportant = rawValue
      .replace(/!\s*important\s*$/i, "")
      .trim();
    const value = isCustomProperty
      ? valueWithoutImportant
      : valueWithoutImportant.toLowerCase();
    const previous = declarationsByProperty.get(property);

    if (previous && ["position", "z-index"].includes(property)) {
      hasAmbiguousPositioningCascade = true;
    }
    if (!previous || important || !previous.important) {
      declarationsByProperty.set(property, { value, important });
    }
  }

  const values = new Map<string, string>();
  declarationsByProperty.forEach((declaration, property) => {
    values.set(property, declaration.value);
  });
  return { values, hasAmbiguousPositioningCascade };
}

function isOpaqueHexColor(value: string): boolean {
  const compact = value.trim().toLowerCase();
  return (
    /^#[0-9a-f]{3}$/.test(compact) ||
    /^#[0-9a-f]{6}$/.test(compact) ||
    /^#[0-9a-f]{3}f$/.test(compact) ||
    /^#[0-9a-f]{6}ff$/.test(compact)
  );
}

function isReadableAbsoluteFontSize(value: string): boolean {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)px$/);
  if (!match) return false;
  const pixels = Number(match[1]);
  return Number.isFinite(pixels) && pixels >= 8 && pixels <= 96;
}

function isReadableArbitraryLineHeight(value: string): boolean {
  const trimmed = value.trim();
  const unitless = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (unitless) {
    const multiplier = Number(unitless[1]);
    return Number.isFinite(multiplier) && multiplier >= 1;
  }
  return isReadableAbsoluteFontSize(trimmed);
}

function classifyReadableArbitraryTextValue(
  value: string
): "color" | "font-size" | null {
  const normalized = value.trim().replace(/_/g, " ");
  const brandVariable = normalized.match(/^var\((--brand-[a-z-]+)\)$/);
  if (brandVariable) {
    return READABLE_BRAND_TEXT_VARIABLES.has(brandVariable[1])
      ? "color"
      : null;
  }
  if (normalized.startsWith("color:")) {
    return isOpaqueHexColor(normalized.slice("color:".length))
      ? "color"
      : null;
  }
  if (normalized.startsWith("length:")) {
    return isReadableAbsoluteFontSize(normalized.slice("length:".length))
      ? "font-size"
      : null;
  }
  if (isOpaqueHexColor(normalized)) return "color";
  if (isReadableAbsoluteFontSize(normalized)) return "font-size";
  return null;
}

function utilityDefinesTinyOrUnverifiableDimension(
  utility: string,
  axis: "x" | "y"
): boolean {
  const dimension =
    axis === "x" ? "(?:max-w|size|w)" : "(?:h|max-h|size)";
  if (new RegExp(`^${dimension}-(?:0|px)$`).test(utility)) return true;

  const spacing = utility.match(new RegExp(`^${dimension}-(\\d+(?:\\.\\d+)?)$`));
  if (spacing) {
    // Tailwind's default spacing scale is 0.25rem per unit. At the default
    // 16px root size, values below 2 provide less than 8px of readable space.
    return Number(spacing[1]) < 2;
  }

  const arbitrary = utility.match(
    new RegExp(`^${dimension}-\\[([^\\]]+)\\]$`)
  );
  if (!arbitrary) return false;
  const pixels = arbitrary[1].trim().match(/^(\d+(?:\.\d+)?)px$/);
  return !pixels || Number(pixels[1]) < 8;
}

function overflowUtilityConcealsContent(utilities: string[]): boolean {
  const globalOverflow = utilities.some((utility) =>
    /^overflow-(?:auto|clip|hidden|scroll)$/.test(utility)
  );
  const horizontalOverflow =
    globalOverflow ||
    utilities.some((utility) =>
      /^overflow-x-(?:auto|clip|hidden|scroll)$/.test(utility)
    );
  const verticalOverflow =
    globalOverflow ||
    utilities.some((utility) =>
      /^overflow-y-(?:auto|clip|hidden|scroll)$/.test(utility)
    );

  return (
    (horizontalOverflow &&
      utilities.some((utility) =>
        utilityDefinesTinyOrUnverifiableDimension(utility, "x")
      )) ||
    (verticalOverflow &&
      utilities.some((utility) =>
        utilityDefinesTinyOrUnverifiableDimension(utility, "y")
      ))
  );
}

function normalizeTailwindColorToken(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "white") return "#ffffff";
  if (normalized === "black") return "#000000";
  const arbitrary = normalized.match(/^\[(?:color:)?(#[0-9a-f]+)\]$/);
  if (!arbitrary) return normalized;
  const hex = arbitrary[1];
  if (/^#[0-9a-f]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  if (/^#[0-9a-f]{4}$/.test(hex) && hex[4] === "f") {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  if (/^#[0-9a-f]{8}$/.test(hex) && hex.endsWith("ff")) {
    return hex.slice(0, 7);
  }
  return hex;
}

function utilitiesHaveMatchingForegroundAndBackground(
  utilities: string[]
): boolean {
  const foregrounds = new Set(
    utilities
      .filter((utility) => utility.startsWith("text-"))
      .map((utility) =>
        normalizeTailwindColorToken(utility.slice("text-".length))
      )
  );
  return utilities
    .filter((utility) => utility.startsWith("bg-"))
    .map((utility) =>
      normalizeTailwindColorToken(utility.slice("bg-".length))
    )
    .some((background) => foregrounds.has(background));
}

function parseCssOpacity(value: string): number | null {
  const trimmed = value.trim();
  const percentage = trimmed.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))%$/);
  if (percentage) {
    const parsed = Number(percentage[1]) / 100;
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function utilityClassesSuppress(className: string): boolean {
  const rawTokens = className
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const tokens = rawTokens.map((token) => token.toLowerCase());
  const utilities = tokens.map(tailwindUtilityFromToken);
  const rawUtilities = rawTokens.map(tailwindUtilityFromToken);

  if (utilities.some((utility) => HIDDEN_UTILITY_CLASSES.has(utility))) {
    return true;
  }
  if (utilitiesHaveMatchingForegroundAndBackground(utilities)) return true;
  if (overflowUtilityConcealsContent(utilities)) return true;
  if (
    utilities.some((utility, index) => {
      if (/^(?:scale-[xy]-0|scale-\[0(?:\.0+)?\])$/.test(utility)) {
        return true;
      }
      const standardScale = utility.match(/^-?scale(?:-[xy])?-(\d{1,3})$/);
      if (
        standardScale &&
        (utility.startsWith("-") || Number(standardScale[1]) !== 100)
      ) {
        return true;
      }
      const arbitraryScale = utility.match(
        /^scale(?:-[xy])?-\[([^\]]+)\]$/
      );
      if (
        arbitraryScale &&
        !/^1(?:\.0+)?$/.test(arbitraryScale[1].trim())
      ) {
        return true;
      }
      const opacity = utility.match(/^opacity-(\d{1,3})$/);
      if (opacity && Number(opacity[1]) < 100) return true;
      const arbitraryOpacity = utility.match(/^opacity-\[([^\]]+)\]$/);
      if (arbitraryOpacity) {
        const parsed = parseCssOpacity(arbitraryOpacity[1]);
        return parsed === null || parsed < 1;
      }
      const textOpacity = utility.match(/^text-opacity-(\d{1,3})$/);
      if (textOpacity && Number(textOpacity[1]) < 100) return true;
      if (/^text-opacity-\[/.test(utility)) return true;
      // A slash after a named Tailwind text utility can mean either a
      // line-height or a color alpha. The generated compliance page uses no
      // such shorthand, so ambiguous modifiers fail closed.
      if (/^text-(?!\[)[^/]+\//.test(utility)) return true;
      const rawUtility = rawUtilities[index];
      const arbitraryText = rawUtility.match(
        /^text-\[([^\]]+)\](?:\/(?:\[([^\]]+)\]|([^/]+)))?$/
      );
      if (arbitraryText) {
        const textValueKind = classifyReadableArbitraryTextValue(
          arbitraryText[1]
        );
        const arbitraryLineHeight = (
          arbitraryText[2] ??
          arbitraryText[3] ??
          ""
        ).replace(/_/g, " ");
        if (textValueKind === null) return true;
        if (textValueKind === "color" && arbitraryLineHeight !== "") {
          return true;
        }
        if (
          textValueKind === "font-size" &&
          arbitraryLineHeight !== "" &&
          !isReadableArbitraryLineHeight(arbitraryLineHeight)
        ) return true;
      }
      const arbitraryTracking = utility.match(/^tracking-\[([^\]]+)\]$/);
      if (arbitraryTracking) {
        const em = arbitraryTracking[1]
          .trim()
          .match(/^(\d+(?:\.\d+)?)em$/);
        if (!em || Number(em[1]) > 0.25) return true;
      }
      const arbitraryLeading = utility.match(
        /^(?:leading|text-[^/]+\/)-?\[([^\]]+)\]$/
      );
      if (arbitraryLeading) {
        const lineHeight = arbitraryLeading[1].replace(/_/g, " ");
        if (!isReadableArbitraryLineHeight(lineHeight)) return true;
      }
      if (
        /^-?translate-[xy]-\[/.test(utility) ||
        /^-?m[trblxy]?-\[/.test(utility) ||
        /^-?indent-/.test(utility) ||
        /^\[[^\]]+:/.test(utility)
      ) {
        return true;
      }
      return (
        utility === "truncate" ||
        utility === "whitespace-nowrap" ||
        utility === "whitespace-pre" ||
        utility.startsWith("line-clamp-") ||
        /^(?:blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|saturate|sepia)(?:-|$)/.test(
          utility
        ) ||
        /^(?:backdrop-)?filter(?:-|$)/.test(utility) ||
        /^mix-blend-/.test(utility) ||
        /^-(?:translate-[xy]|left|right|top|bottom|inset(?:-[xy])?|m[trblxy]?|indent)-/.test(
          utility
        ) ||
        ["h-0", "max-h-0", "max-w-0", "size-0", "w-0"].includes(
          utility
        ) ||
        /^(?:-?translate-[xy]-full|-?(?:left|right|top|bottom|inset(?:-[xy])?)-(?:full|\[))/.test(
          utility
        ) ||
        /^(?:translate-[xy]|left|right|top|bottom)-\[-/.test(utility)
      );
    })
  ) {
    return true;
  }
  if (
    tokens.some((token) =>
      [
        "[display:none]",
        "[visibility:hidden]",
        "[visibility:collapse]",
        "[content-visibility:hidden]",
        "[opacity:0]",
        "[pointer-events:none]",
      ].some((value) => token.includes(value))
    )
  ) {
    return true;
  }
  return false;
}

function tailwindUtilityFromToken(token: string): string {
  let bracketDepth = 0;
  let lastVariantSeparator = -1;
  for (let index = 0; index < token.length; index += 1) {
    const character = token[index];
    if (character === "[") bracketDepth += 1;
    if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (character === ":" && bracketDepth === 0) {
      lastVariantSeparator = index;
    }
  }
  return token.slice(lastVariantSeparator + 1).replace(/^!/, "");
}

function elementContainsText(
  dom: VisibleDom,
  element: DomElement,
  expected: string
): boolean {
  return elementText(dom, element).includes(normalizeWhitespace(expected));
}

function elementsFor(dom: VisibleDom, tagName: string): DomElement[] {
  return dom.elementsByTag.get(tagName) ?? [];
}

function elementText(dom: VisibleDom, element: DomElement): string {
  const cached = dom.normalizedTextByElement.get(element);
  if (cached !== undefined) return cached;
  const range = dom.rangeByElement.get(element);
  if (!range) return "";
  const rangeLength = range.end - range.start;
  if (
    dom.inspectedTextLength + rangeLength >
    PUBLIC_COMPLIANCE_PAGE_MAX_DERIVED_TEXT_LENGTH
  ) {
    // Fail closed without allocating another overlapping descendant slice.
    return "";
  }
  dom.inspectedTextLength += rangeLength;
  const normalized = normalizeWhitespace(
    dom.visibleText.slice(range.start, range.end)
  );
  dom.normalizedTextByElement.set(element, normalized);
  return normalized;
}

function visibleHeadings(dom: VisibleDom): DomElement[] {
  return ["h1", "h2", "h3", "h4", "h5", "h6"].flatMap((tagName) =>
    elementsFor(dom, tagName)
  );
}

function findVisibleAnchor(
  dom: VisibleDom,
  href: string,
  expectedText: string
): DomElement | null {
  const normalizedText = normalizeWhitespace(expectedText);
  return (
    elementsFor(dom, "a").find(
      (element) =>
        element.attribs.href?.trim() === href &&
        elementText(dom, element) === normalizedText
    ) ?? null
  );
}

function nearestVisibleAncestor(
  dom: VisibleDom,
  element: DomElement,
  tagName: string
): DomElement | null {
  let ancestor = element.parent ?? null;
  let depth = 0;
  while (ancestor) {
    depth += 1;
    if (depth > PUBLIC_COMPLIANCE_PAGE_MAX_DOM_DEPTH) return null;
    if (
      isElement(ancestor) &&
      dom.rangeByElement.has(ancestor) &&
      ancestor.name === tagName
    ) {
      return ancestor;
    }
    ancestor = ancestor.parent ?? null;
  }
  return null;
}

function isDescendantOf(element: DomElement, ancestor: DomElement): boolean {
  let current = element.parent ?? null;
  let depth = 0;
  while (current) {
    depth += 1;
    if (depth > PUBLIC_COMPLIANCE_PAGE_MAX_DOM_DEPTH) return false;
    if (current === ancestor) return true;
    current = current.parent ?? null;
  }
  return false;
}

function hasVisibleHeadingWithin(
  dom: VisibleDom,
  container: DomElement,
  headingText: string
): boolean {
  const expected = normalizeWhitespace(headingText);
  return visibleHeadings(dom).some(
    (element) =>
      isDescendantOf(element, container) &&
      elementText(dom, element) === expected
  );
}

function hasVisibleHeadingBlock(
  dom: VisibleDom,
  headingText: string,
  expectedFragments: string[]
): boolean {
  const expectedHeading = normalizeWhitespace(headingText);
  const seenSections = new Set<DomElement>();
  const candidateSections: DomElement[] = [];

  for (const element of visibleHeadings(dom)) {
    if (elementText(dom, element) !== expectedHeading) continue;
    const section = nearestVisibleAncestor(dom, element, "section");
    if (section && !seenSections.has(section)) {
      seenSections.add(section);
      candidateSections.push(section);
    }
  }

  return candidateSections.some((section) =>
    expectedFragments.every((fragment) =>
      elementContainsText(dom, section, fragment)
    )
  );
}

function hasVisibleDefinition(
  dom: VisibleDom,
  label: string,
  expectedValue: string,
  link?: { href: string; anchorText: string }
): boolean {
  const expectedLabel = normalizeWhitespace(label);
  const expectedDefinition = normalizeWhitespace(expectedValue);
  let linkedDefinition: DomElement | null = null;

  if (link) {
    const expectedAnchorText = normalizeWhitespace(link.anchorText);
    const anchor = elementsFor(dom, "a").find(
      (element) =>
        element.attribs.href?.trim() === link.href &&
        elementText(dom, element) === expectedAnchorText
    );
    linkedDefinition = anchor
      ? nearestVisibleAncestor(dom, anchor, "dd")
      : null;
    if (!linkedDefinition) return false;
  }

  return dom.definitionPairs.some(({ term, definition }) => {
    return (
      elementText(dom, term) === expectedLabel &&
      elementText(dom, definition).includes(expectedDefinition) &&
      (linkedDefinition === null || definition === linkedDefinition)
    );
  });
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
