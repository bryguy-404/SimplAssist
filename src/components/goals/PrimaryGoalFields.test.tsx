import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  PRIMARY_GOAL_COPY,
  PRIMARY_GOAL_OPTIONS,
  type EditablePrimaryGoal,
} from "@/lib/goals/primaryGoal";
import { PrimaryGoalFields } from "./PrimaryGoalFields";

function renderFields(
  primaryGoal: EditablePrimaryGoal | null,
  goalUrl = "",
  disabled = false
) {
  return renderToStaticMarkup(
    <PrimaryGoalFields
      primaryGoal={primaryGoal}
      goalUrl={goalUrl}
      onPrimaryGoalChange={vi.fn()}
      onGoalUrlChange={vi.fn()}
      disabled={disabled}
    />
  );
}

function renderedCopy(value: string): string {
  return renderToStaticMarkup(<>{value}</>);
}

function primaryGoalInput(markup: string, value: EditablePrimaryGoal) {
  return (markup.match(/<input\b[^>]*>/g) ?? []).find(
    (input) =>
      input.includes('name="primary_goal"') &&
      input.includes(`value="${value}"`)
  );
}

describe("PrimaryGoalFields", () => {
  it("renders the authoritative copy byte-identically and in order", () => {
    const markup = renderFields(null);
    const copy = [
      PRIMARY_GOAL_COPY.question,
      PRIMARY_GOAL_COPY.options.book,
      PRIMARY_GOAL_COPY.options.signup,
      PRIMARY_GOAL_COPY.helper,
    ].map((value) => renderedCopy(value));

    expect(copy).toEqual([
      renderedCopy("What should your assistant help customers do?"),
      renderedCopy("Book a time with me — jobs, visits, or appointments"),
      renderedCopy("Go to my website — to sign up, order, or learn more"),
      renderedCopy(
        "Pick the main one. Your AI still handles everything else customers ask — this just sets what it steers toward. You can change it anytime in Settings."
      ),
    ]);

    const positions = copy.map((value) => markup.indexOf(value));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("shows exactly book and signup with no default or auto-suggestion", () => {
    const markup = renderFields(null);

    expect(PRIMARY_GOAL_OPTIONS.map(({ value }) => value)).toEqual([
      "book",
      "signup",
    ]);
    expect(markup.match(/name="primary_goal"/g)).toHaveLength(2);
    expect(markup).not.toContain('checked=""');
    expect(markup).not.toContain('name="goal_url"');
    expect(markup).not.toContain("quote");
    expect(markup).not.toContain("callback");
  });

  it("rehydrates only the selected book option without rendering goal_url", () => {
    const markup = renderFields("book", "https://example.com/retained");

    expect(primaryGoalInput(markup, "book")).toContain('checked=""');
    expect(primaryGoalInput(markup, "signup")).not.toContain('checked=""');
    expect(markup).not.toContain('name="goal_url"');
  });

  it("renders the controlled signup URL field with the locked attributes", () => {
    const markup = renderFields("signup", "https://example.com/signup");

    expect(primaryGoalInput(markup, "signup")).toContain('checked=""');
    expect(markup).toContain('type="url"');
    expect(markup).toContain('id="goal_url"');
    expect(markup).toContain('name="goal_url"');
    expect(markup).toContain('aria-label="Website link"');
    expect(markup).toContain('placeholder="https://"');
    expect(markup).toContain('minLength="9"');
    expect(markup).toContain('maxLength="2048"');
    expect(markup).toContain('value="https://example.com/signup"');
    expect(markup).toContain('required=""');
  });

  it("disables the complete controlled fieldset", () => {
    expect(renderFields(null, "", true)).toMatch(/^<fieldset[^>]* disabled=""/);
  });

  it("can disable one option while leaving the other option enabled", () => {
    const markup = renderToStaticMarkup(
      <PrimaryGoalFields
        primaryGoal="book"
        goalUrl=""
        onPrimaryGoalChange={vi.fn()}
        onGoalUrlChange={vi.fn()}
        disabledOptions={["signup"]}
      />
    );

    expect(primaryGoalInput(markup, "book")).not.toContain('disabled=""');
    expect(primaryGoalInput(markup, "signup")).toContain('disabled=""');
  });

  it("supports a helper override while preserving the default helper", () => {
    const customMarkup = renderToStaticMarkup(
      <PrimaryGoalFields
        primaryGoal="book"
        goalUrl=""
        onPrimaryGoalChange={vi.fn()}
        onGoalUrlChange={vi.fn()}
        helper={<a href="/support">Custom helper</a>}
      />
    );

    expect(customMarkup).toContain('<a href="/support">Custom helper</a>');
    expect(customMarkup).not.toContain(renderedCopy(PRIMARY_GOAL_COPY.helper));
    expect(renderFields("book")).toContain(
      renderedCopy(PRIMARY_GOAL_COPY.helper)
    );
  });
});
