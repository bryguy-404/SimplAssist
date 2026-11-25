import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("./client", () => ({
  RESEND_FROM: "SimplAssist <notifications@simplassist.com>",
  resend: { emails: { send: mocks.send } },
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: vi.fn() } }));

import type { BusinessEmailBrand } from "./businessEmailBrand.server";
import { renderGiftCodeEmail } from "./giftCodeTemplate";
import {
  appendLegalFooter,
  SIMPLASSIST_LEGAL_LINE,
  SIMPLASSIST_LEGAL_LINE_HTML,
} from "./legalFooter";
import { sendBusinessEmail } from "./sender";

const LINE = "SimplAssist is a product of Arambula Ventures LLC.";
const DEFAULT_BRAND: BusinessEmailBrand = {
  partnerId: null,
  name: "SimplAssist",
  publicOrigin: "https://simplassist.com",
  from: "SimplAssist <notifications@simplassist.com>",
  usedFallbackSender: false,
};
const PARTNER_BRAND: BusinessEmailBrand = {
  partnerId: "20000000-0000-4000-a000-000000000001",
  name: "Alpha Dog Agency",
  publicOrigin: "https://app.alphadogagency.ai",
  from: '"Alpha Dog Agency" <hello@alphadogagency.ai>',
  usedFallbackSender: false,
};
const MESSAGE = {
  to: ["client@example.com"],
  subject: "Account update",
  text: "Hello\n\n— The SimplAssist Team",
  html: "<p>Hello</p><p>— The SimplAssist Team</p>",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.send.mockResolvedValue({ data: { id: "email-1" }, error: null });
});

describe("the legal line", () => {
  it("names the company with the same wording as the website footer", () => {
    expect(SIMPLASSIST_LEGAL_LINE).toBe(LINE);
    expect(SIMPLASSIST_LEGAL_LINE_HTML).toContain(LINE);
  });

  it("is appended after the existing text and HTML, leaving both intact", () => {
    const result = appendLegalFooter(MESSAGE);

    expect(result.text).toBe(`${MESSAGE.text}\n\n${LINE}`);
    expect(result.html).toBe(`${MESSAGE.html}${SIMPLASSIST_LEGAL_LINE_HTML}`);
    expect(result.subject).toBe(MESSAGE.subject);
    expect(result.to).toEqual(MESSAGE.to);
    expect(MESSAGE.text).not.toContain(LINE);
  });

  it("only touches the parts a message has", () => {
    const textOnly = { subject: "x", text: "Hello" };
    expect(appendLegalFooter(textOnly)).toEqual({
      subject: "x",
      text: `Hello\n\n${LINE}`,
    });
    const neither: { subject: string; text?: string; html?: string } = { subject: "x" };
    expect(appendLegalFooter(neither)).toEqual({ subject: "x" });
  });
});

describe("sendBusinessEmail and the legal line", () => {
  it("adds it to a customer email sent under SimplAssist's own brand", async () => {
    await sendBusinessEmail({ brand: DEFAULT_BRAND, context: "passwordReset", message: MESSAGE });

    const sent = mocks.send.mock.calls[0][0];
    expect(sent.text.endsWith(LINE)).toBe(true);
    expect(sent.html.endsWith(SIMPLASSIST_LEGAL_LINE_HTML)).toBe(true);
    expect(sent.from).toBe(DEFAULT_BRAND.from);
  });

  it.each([
    ["a verified partner sender", PARTNER_BRAND],
    ["a partner falling back to the SimplAssist sender", { ...PARTNER_BRAND, from: DEFAULT_BRAND.from, usedFallbackSender: true }],
  ])("never adds it to a white-label email from %s", async (_label, brand) => {
    await sendBusinessEmail({ brand, context: "passwordReset", message: MESSAGE });

    const sent = mocks.send.mock.calls[0][0];
    expect(sent.text).toBe(MESSAGE.text);
    expect(sent.html).toBe(MESSAGE.html);
    expect(JSON.stringify(sent)).not.toMatch(/Arambula|SimplAssist is a product/);
  });

  it("leaves internal notifications as they were", async () => {
    await sendBusinessEmail({ brand: DEFAULT_BRAND, context: "supportTicket", internal: true, message: MESSAGE });

    const sent = mocks.send.mock.calls[0][0];
    expect(sent.text).toBe(MESSAGE.text);
    expect(sent.html).toBe(MESSAGE.html);
  });
});

describe("the coupon email", () => {
  it("ends with the legal line in both versions, without adding a link", () => {
    const { html, text } = renderGiftCodeEmail({
      firstName: "Rosa",
      code: "ROSA-FREEMONTH",
      offer: { kind: "percent", percentOff: 100, duration: "once", months: null },
      expiresAt: null,
      startUrl: "https://simplassist.com/gift/ROSA-FREEMONTH/start",
    });

    expect(text.endsWith(LINE)).toBe(true);
    expect(html).toContain(`>${LINE}</td>`);
    expect(html.indexOf(LINE)).toBeGreaterThan(html.indexOf("The SimplAssist team"));
    expect(html.match(/href="/g)).toHaveLength(1);
  });
});
