import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import UpgradePrompt from "./UpgradePrompt";
const prompt = { kind: "offer" as const, offerKey: "review_texting" as const, title: "Make leaving a review easier", description: "Send a friendly text after a completed job.", actionLabel: "Explore text reminders", href: "/reviews?tab=settings#review-sms", revision: 0 };
describe("dashboard upgrade prompt", () => {
  it("uses a nonmodal benefit-led invitation and navigation only", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const html = renderToStaticMarkup(<UpgradePrompt prompt={prompt} />);
    expect(html).toContain('<aside'); expect(html).toContain('aria-labelledby="upgrade-prompt-title"');
    expect(html).toContain('href="/reviews?tab=settings#review-sms"'); expect(html).toContain("Not now");
    expect(html).toContain("Don’t show this suggestion again"); expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Confirm"); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  });
  it("keeps operational progress separate from hideable promotions", () => {
    const html = renderToStaticMarkup(<UpgradePrompt prompt={{ ...prompt, kind: "progress" }} />);
    expect(html).not.toContain("Not now"); expect(html).not.toContain("Don’t show");
  });
});
