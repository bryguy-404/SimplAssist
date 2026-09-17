import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import { PlanSelectionOption } from "./PlanSelectionOption";

describe("PlanSelectionOption", () => {
  it("renders no acquisition control for a hidden chat-only plan", () => {
    const markup = renderToStaticMarkup(
      <PlanSelectionOption
        inputName="plan"
        planKey="chat_only"
        plan={SUBSCRIPTION_PLANS.chat_only}
        selected={false}
        recommended={false}
        onSelect={vi.fn()}
      />
    );

    expect(markup).toBe("");
  });

  it("renders Full Suite as a non-selectable waitlist card when its gate is closed", () => {
    const markup = renderToStaticMarkup(
      <PlanSelectionOption
        inputName="plan"
        planKey="full"
        plan={SUBSCRIPTION_PLANS.full}
        selected={false}
        recommended={false}
        onSelect={vi.fn()}
        availabilityOverride="coming_soon"
      />
    );

    expect(markup).toContain("Coming Soon");
    expect(markup).toContain("Notify Me When It Launches");
    expect(markup).not.toContain('type="radio"');
    expect(markup.startsWith("<div")).toBe(true);
  });

  it("makes public Full Suite selectable with its actual activation total", () => {
    const markup = renderToStaticMarkup(<PlanSelectionOption inputName="plan" planKey="full" plan={SUBSCRIPTION_PLANS.full}
      selected={false} recommended={false} onSelect={vi.fn()} />);
    expect(markup).toContain('type="radio"');
    expect(markup).toContain('value="full"');
    expect(markup).toContain("$90 today");
    expect(markup).toContain("$65/month");
    expect(markup).not.toContain("Coming Soon");
    expect(markup).not.toContain("Notify Me When It Launches");
  });

  it("keeps an available plan selectable", () => {
    const markup = renderToStaticMarkup(
      <PlanSelectionOption
        inputName="plan"
        planKey="sms_and_chat"
        plan={SUBSCRIPTION_PLANS.sms_and_chat}
        selected
        recommended
        onSelect={vi.fn()}
      />
    );

    expect(markup.startsWith("<label")).toBe(true);
    expect(markup).toContain('type="radio"');
    expect(markup).not.toContain("Notify Me When It Launches");
  });
});
