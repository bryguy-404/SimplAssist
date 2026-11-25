import { describe, expect, it } from "vitest";
import type { GiftOffer } from "@/lib/gift/code";
import { cleanFirstName, renderGiftCodeEmail } from "./giftCodeTemplate";

const freeMonth: GiftOffer = { kind: "percent", percentOff: 100, duration: "once", months: null };
const base = {
  firstName: "Rosa",
  code: "ROSA-FREEMONTH",
  offer: freeMonth,
  expiresAt: "2027-01-31T23:59:59.000Z",
  giftUrl: "https://simplassist.com/gift/ROSA-FREEMONTH",
};

describe("renderGiftCodeEmail", () => {
  it("shows the code, the offer, the expiry, the page button and where to type it", () => {
    const { subject, html, text } = renderGiftCodeEmail(base);

    expect(subject).toBe("Rosa, here’s your free month of SimplAssist");
    for (const body of [html, text]) {
      expect(body).toContain("ROSA-FREEMONTH");
      expect(body).toContain("Rosa, your first month is on us");
      expect(body).toContain("your first month free");
      expect(body).toContain("Good until January 31, 2027.");
      expect(body).toContain("https://simplassist.com/gift/ROSA-FREEMONTH");
      expect(body).toContain("Prefer to type it? At checkout, choose “Add promotion code” and paste the code there.");
    }
    expect(html).toContain('<a href="https://simplassist.com/gift/ROSA-FREEMONTH"');
    expect(html).toContain(">Open my gift</a>");
  });

  it("is safe for real inboxes: no script, no image, no outside resource", () => {
    const { html } = renderGiftCodeEmail(base);

    expect(html).not.toMatch(/<script|<img|<svg|<link|<iframe|javascript:|url\(|@import|@keyframes|animation/i);
    // The brand name is text, and the only link is the coupon page.
    expect(html).toContain(">SimplAssist</td>");
    expect(Array.from(html.matchAll(/href="([^"]+)"/g), (match) => match[1])).toEqual([base.giftUrl]);
  });

  it("draws the still dot from plain shapes: one orange circle and two eyes", () => {
    const { html } = renderGiftCodeEmail(base);

    expect(html.match(/bgcolor="#ea580c" style="width:76px;height:76px;border-radius:38px/g)).toHaveLength(1);
    expect(html.match(/width="10" height="15" bgcolor="#3a1505"/g)).toHaveLength(2);
  });

  it("makes the code big, monospaced and selectable in one go", () => {
    const { html } = renderGiftCodeEmail(base);
    const codeLine = html.split("\n").find((line) => line.includes("sa-code\""));

    expect(codeLine).toContain("font-size:30px");
    expect(codeLine).toContain("user-select:all");
    expect(codeLine).toContain("monospace");
    expect(codeLine).toContain(">ROSA-FREEMONTH</p>");
  });

  it("works without a name or an expiry", () => {
    const { subject, html, text } = renderGiftCodeEmail({ ...base, firstName: null, expiresAt: null });

    expect(subject).toBe("Here’s your free month of SimplAssist");
    expect(html).toContain("Your first month is on us");
    expect(html).not.toContain("Good until");
    expect(text).not.toContain("Good until");
  });

  it("does not promise a free month when the code gives something else", () => {
    const { subject, html, text } = renderGiftCodeEmail({
      ...base,
      code: "ROSA-HALF",
      giftUrl: "https://simplassist.com/gift/ROSA-HALF",
      offer: { kind: "percent", percentOff: 50, duration: "repeating", months: 3 },
    });

    expect(subject).toBe("A gift for you from SimplAssist");
    expect(html).toContain("50% off your first 3 months");
    expect(html).not.toMatch(/free|on us/i);
    expect(text).not.toMatch(/free|on us/i);
  });

  it("escapes anything typed into the name field", () => {
    const { html, subject } = renderGiftCodeEmail({
      ...base,
      firstName: 'Ro"sa & <b>Co</b>',
    });

    expect(html).not.toContain("<b>");
    expect(html).toContain("Ro&quot;sa &amp; b Co /b");
    expect(subject).not.toContain("<");
  });

  it.each([
    "javascript:alert(1)",
    "https://user:pw@simplassist.com/gift/X",
    "https://simplassist.com/admin",
    "not a url",
  ])("refuses a link that is not a coupon page (%s)", (giftUrl) => {
    expect(() => renderGiftCodeEmail({ ...base, giftUrl })).toThrow();
  });
});

describe("cleanFirstName", () => {
  it("trims, flattens and bounds the name", () => {
    expect(cleanFirstName("  Rosa  ")).toBe("Rosa");
    expect(cleanFirstName("Rosa\nMaria")).toBe("Rosa Maria");
    expect(cleanFirstName("")).toBeNull();
    expect(cleanFirstName("   ")).toBeNull();
    expect(cleanFirstName(null)).toBeNull();
    expect(cleanFirstName("x".repeat(61))).toBeNull();
  });
});
