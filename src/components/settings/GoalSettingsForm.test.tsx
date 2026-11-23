import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PrimaryGoal } from "@/types/database";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

import {
  PRIMARY_GOAL_COPY,
  buildPrimaryGoalUpdate,
} from "@/lib/goals/primaryGoal";
import {
  GOAL_SIGNUP_LOCK_COPY,
  SETTINGS_REGISTRATION_LOCK_CODE,
} from "@/lib/settings/registrationLockCopy";
import GoalSettingsForm, {
  createGoalSettingsDraft,
  reduceGoalSettingsDraft,
  saveGoalSettings,
} from "./GoalSettingsForm";

function renderForm(
  initialPrimaryGoal: PrimaryGoal | null,
  initialGoalUrl: string | null = null,
  registrationLocked = false,
  canUseCalendar = true
): string {
  return renderToStaticMarkup(
    <GoalSettingsForm
      initialPrimaryGoal={initialPrimaryGoal}
      initialGoalUrl={initialGoalUrl}
      registrationLocked={registrationLocked}
      canUseCalendar={canUseCalendar}
    />
  );
}

function renderedCopy(value: string): string {
  return renderToStaticMarkup(<>{value}</>);
}

function primaryGoalInput(markup: string, value: "book" | "signup") {
  return (markup.match(/<input\b[^>]*>/g) ?? []).find(
    (input) =>
      input.includes('name="primary_goal"') &&
      input.includes(`value="${value}"`)
  );
}

function submitButton(markup: string): string {
  const button = (markup.match(/<button\b[^>]*>/g) ?? []).find((candidate) =>
    candidate.includes('type="submit"')
  );
  if (!button) throw new Error("missing submit button");
  return button;
}

describe("GoalSettingsForm", () => {
  it("only offers a Google Calendar connection when the plan includes it", () => {
    const eligible = renderForm("book");
    const smsOnly = renderForm("book", null, false, false);
    expect(eligible).toContain("You can connect Google Calendar");
    expect(smsOnly).toContain("require a plan with calendar access");
    expect(smsOnly).not.toContain("You can connect Google Calendar");
  });

  it("renders the exact shared copy in order with only the v1 options", () => {
    const markup = renderForm(null);
    const copy = [
      PRIMARY_GOAL_COPY.question,
      PRIMARY_GOAL_COPY.options.book,
      PRIMARY_GOAL_COPY.options.signup,
      PRIMARY_GOAL_COPY.helper,
    ].map(renderedCopy);
    const positions = copy.map((value) => markup.indexOf(value));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(markup.match(/name="primary_goal"/g)).toHaveLength(2);
    expect(markup).not.toContain("quote");
    expect(markup).not.toContain("callback");
    expect(markup).toContain("Save Settings");
  });

  it.each([
    ["book", "book"],
    ["signup", "signup"],
  ] as const)("rehydrates only the stored %s selection", (goal, selected) => {
    const markup = renderForm(goal, "https://example.com/signup");
    const other = selected === "book" ? "signup" : "book";

    expect(primaryGoalInput(markup, selected)).toContain('checked=""');
    expect(primaryGoalInput(markup, other)).not.toContain('checked=""');
  });

  it("shows goal_url only for signup", () => {
    expect(renderForm("book", "https://example.com/retained")).not.toContain(
      'name="goal_url"'
    );
    expect(renderForm("signup", "https://example.com/signup")).toContain(
      'value="https://example.com/signup"'
    );
  });

  it.each([null, "quote", "callback"] as const)(
    "leaves initial goal %s unselected and performs no automatic write",
    (goal) => {
      const markup = renderForm(goal, "https://example.com/retained");

      expect(primaryGoalInput(markup, "book")).not.toContain('checked=""');
      expect(primaryGoalInput(markup, "signup")).not.toContain('checked=""');
      expect(submitButton(markup)).toContain('disabled=""');
    }
  );

  it.each([
    "",
    "   ",
    "http://example.com",
    "HTTP://example.com",
    "https://",
    "https:///path",
    "not a url",
    "https://example.com/a path",
    `https://example.com/${"a".repeat(2030)}`,
  ])("blocks Save Settings for invalid signup URL %s", (goalUrl) => {
    expect(submitButton(renderForm("signup", goalUrl))).toContain(
      'disabled=""'
    );
  });

  it.each([
    "https://a",
    "https://Example.COM/Path?Camp=Summer#SignUp",
    "HTTPS://Example.COM/Path?Camp=Summer#SignUp",
    "HttpS://example.com/Class?Program=Fall#Register",
    "  https://example.com/SignUp?Source=AI#Form  ",
  ])("enables Save Settings for valid signup URL %s", (goalUrl) => {
    expect(submitButton(renderForm("signup", goalUrl))).not.toContain(
      'disabled=""'
    );
  });

  it("retains the initial URL while switching to book and back to signup", () => {
    const initial = {
      primaryGoal: "signup" as const,
      goalUrl: "https://example.com/retained",
    };
    const book = reduceGoalSettingsDraft(initial, {
      type: "primary_goal",
      value: "book",
    });
    const signup = reduceGoalSettingsDraft(book, {
      type: "primary_goal",
      value: "signup",
    });

    expect(book).toEqual({
      primaryGoal: "book",
      goalUrl: "https://example.com/retained",
    });
    expect(signup).toEqual(initial);
  });

  it("rehydrates a stale signup draft from refreshed locked book props", () => {
    const dirtyDraft = reduceGoalSettingsDraft(
      createGoalSettingsDraft("book", "https://example.com/retained"),
      { type: "primary_goal", value: "signup" }
    );

    expect(
      reduceGoalSettingsDraft(dirtyDraft, {
        type: "hydrate",
        initialPrimaryGoal: "book",
        initialGoalUrl: "https://example.com/retained",
      })
    ).toEqual({
      primaryGoal: "book",
      goalUrl: "https://example.com/retained",
    });
  });

  it.each([null, "book", "quote", "callback"] as const)(
    "disables only signup for locked initial goal %s and binds support copy",
    (goal) => {
      const markup = renderForm(goal, "https://example.com/retained", true);
      const visibleText = markup.replace(/<[^>]+>/g, "");
      const lockedHelper =
        "Pick the main one. Your AI still handles everything else customers ask — this just sets what it steers toward.";

      expect(primaryGoalInput(markup, "signup")).toContain('disabled=""');
      expect(primaryGoalInput(markup, "book")).not.toContain('disabled=""');
      expect(markup).toContain(renderedCopy(lockedHelper));
      expect(markup).toContain(
        'href="/support?category=number_registration"'
      );
      expect(visibleText).toContain(GOAL_SIGNUP_LOCK_COPY.message);
      expect(visibleText).toContain(
        "Contact support to change your goal to directing customers to a website because your current goal was filed with your carrier registration."
      );
      expect(markup).not.toContain(renderedCopy(PRIMARY_GOAL_COPY.helper));
    }
  );

  it("keeps both options and signup URL editable when signup was already filed", () => {
    const markup = renderForm(
      "signup",
      "https://example.com/signup",
      true
    );

    expect(primaryGoalInput(markup, "book")).not.toContain('disabled=""');
    expect(primaryGoalInput(markup, "signup")).not.toContain('disabled=""');
    expect(markup).toContain(
      renderedCopy(
        "Pick the main one. Your AI still handles everything else customers ask — this just sets what it steers toward."
      )
    );
    expect(markup).not.toContain(renderedCopy(PRIMARY_GOAL_COPY.helper));
    expect(markup).not.toContain(GOAL_SIGNUP_LOCK_COPY.supportText);
    expect(markup).toContain('name="goal_url"');
  });

  it("does not disable signup before registration starts", () => {
    expect(primaryGoalInput(renderForm("book"), "signup")).not.toContain(
      'disabled=""'
    );
  });
});

describe("saveGoalSettings", () => {
  it("posts one normalized signup payload without a business id, then refreshes", async () => {
    const payload = buildPrimaryGoalUpdate({
      primary_goal: "signup",
      goal_url: "  HttpS://example.com/Path?Camp=Summer#SignUp  ",
    });
    if (!payload) throw new Error("missing payload");
    const fetchMock = vi.fn(
      async (...args: Parameters<typeof fetch>) => {
        void args;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
    );
    const fetcher = fetchMock as typeof fetch;
    const refresh = vi.fn();

    await saveGoalSettings({
      payload,
      refresh,
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/settings/goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        primary_goal: "signup",
        goal_url: "https://example.com/Path?Camp=Summer#SignUp",
      }),
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty(
      "businessId"
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("posts book without goal_url", async () => {
    const payload = buildPrimaryGoalUpdate({
      primary_goal: "book",
      goal_url: "https://example.com/retained",
    });
    if (!payload) throw new Error("missing payload");
    const fetchMock = vi.fn(
      async (...args: Parameters<typeof fetch>) => {
        void args;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
    );
    const fetcher = fetchMock as typeof fetch;

    await saveGoalSettings({
      payload,
      refresh: vi.fn(),
      fetcher,
    });

    const requestBody = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string
    );
    expect(requestBody).toEqual({ primary_goal: "book" });
    expect(requestBody).not.toHaveProperty("goal_url");
  });

  it("refreshes stale UI state when the server reports the registration lock", async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: SETTINGS_REGISTRATION_LOCK_CODE,
          error: GOAL_SIGNUP_LOCK_COPY.message,
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      )
    );
    const refresh = vi.fn();

    await expect(
      saveGoalSettings({
        payload: { primary_goal: "book" },
        refresh,
        fetcher: fetcher as typeof fetch,
      })
    ).rejects.toMatchObject({
      message: GOAL_SIGNUP_LOCK_COPY.message,
      status: 403,
      code: SETTINGS_REGISTRATION_LOCK_CODE,
    });

    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh for a non-locking server failure", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: "failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );
    const refresh = vi.fn();

    await expect(
      saveGoalSettings({
        payload: { primary_goal: "book" },
        refresh,
        fetcher: fetcher as typeof fetch,
      })
    ).rejects.toMatchObject({ message: "failed", status: 500 });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses stable fallback copy when the request itself fails", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const refresh = vi.fn();

    await expect(
      saveGoalSettings({
        payload: { primary_goal: "book" },
        refresh,
        fetcher: fetcher as typeof fetch,
      })
    ).rejects.toMatchObject({
      message: "Could not save your AI settings. Please try again.",
      status: 0,
      code: null,
    });

    expect(refresh).not.toHaveBeenCalled();
  });
});
