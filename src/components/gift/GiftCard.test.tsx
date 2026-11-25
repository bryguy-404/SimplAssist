import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { GiftCard } from "./GiftCard";

describe("GiftCard", () => {
  it("shows the code, what it gives, a copy button and the start button", () => {
    const html = renderToStaticMarkup(
      <GiftCard
        state={{
          kind: "available",
          code: "ROSA-FREEMONTH",
          offer: { kind: "percent", percentOff: 100, duration: "once", months: null },
          expiresAt: "2027-01-31T23:59:59.000Z",
        }}
        startHref="/gift/ROSA-FREEMONTH/start"
      />,
    );

    expect(html).toContain("Your first month is on us");
    expect(html).toContain("your first month free");
    expect(html).toMatch(/data-gift-code=""[^>]*>ROSA-FREEMONTH</);
    expect(html).toContain("Copy code");
    expect(html).toContain("Good until January 31, 2027.");
    expect(html).toMatch(/<a href="\/gift\/ROSA-FREEMONTH\/start"[^>]*>Start free with this code<\/a>/);
    expect(html).toContain("Add promotion code");
  });

  it("leaves out the expiry line when the code has none", () => {
    const html = renderToStaticMarkup(
      <GiftCard
        state={{
          kind: "available",
          code: "HALF-OFF",
          offer: { kind: "percent", percentOff: 50, duration: "once", months: null },
          expiresAt: null,
        }}
        startHref="/gift/HALF-OFF/start"
      />,
    );

    expect(html).not.toContain("Good until");
    expect(html).toContain("Start with this code");
    expect(html).not.toContain("Start free");
  });

  it.each([
    ["unavailable", "This code isn’t available"],
    ["error", "We couldn’t check this code"],
  ] as const)("shows a kind %s state with no code, copy button or start button", (kind, heading) => {
    const html = renderToStaticMarkup(<GiftCard state={{ kind }} startHref="/signup" />);

    expect(html).toContain(heading);
    expect(html).not.toContain("data-gift-code");
    expect(html).not.toContain("Copy code");
    expect(html).not.toContain("data-gift-start");
    expect(html).toContain("mailto:bryan@simplassist.com");
  });
});
