import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PrimaryGoal } from "@/types/database";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(),
}));

import AIPersonalityForm, {
  saveAIPersonalitySettings,
  type AIPersonalityData,
} from "./AIPersonalityForm";

const AUTHORITATIVE_COPY = [
  "When a new customer reaches out, what's the win for you?",
  "I run on a schedule — jobs, visits, or appointments",
  "I need them on a list — a camp, class, program, or event",
  "Pick the main one. Your AI still handles everything else customers ask — this just sets what it steers toward. You can change it anytime in Settings.",
] as const;

function renderForm(
  initialPrimaryGoal: PrimaryGoal | null,
  initialGoalUrl: string | null = null
): string {
  return renderToStaticMarkup(
    <AIPersonalityForm
      businessId="business-1"
      businessName="Example Business"
      initialPrimaryGoal={initialPrimaryGoal}
      initialGoalUrl={initialGoalUrl}
      onNext={vi.fn()}
      onBack={vi.fn()}
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

function sharedAiSettingsBody(markup: string): string {
  const withoutGoalFields = markup.replace(
    /<fieldset\b[^>]*data-primary-goal-fields[^>]*>[\s\S]*?<\/fieldset>/,
    ""
  );
  const start = withoutGoalFields.indexOf("Customize your AI assistant");
  const end = withoutGoalFields.indexOf(
    '<div class="flex justify-between pt-4">'
  );
  return withoutGoalFields.slice(start, end);
}

function dataFor(
  primary_goal: "book" | "signup",
  goal_url: string
): AIPersonalityData {
  return {
    primary_goal,
    goal_url,
    tone: "balanced",
    business_voice: "we",
    language: "en",
    response_delay_seconds: 5,
    web_greeting: "Welcome",
    guardrails: "First rule\nSecond rule",
    booking_enabled: false,
    booking_mode: "collect_info",
  };
}

type SaveClient = Parameters<typeof saveAIPersonalitySettings>[0]["supabase"];

function makeSaveClient(options: {
  businessError?: { message: string } | null;
  widgetError?: { message: string } | null;
} = {}) {
  const events: string[] = [];
  const upserts: Array<{
    table: string;
    payload: unknown;
    options: unknown;
  }> = [];
  const updates: Array<{ table: string; payload: unknown }> = [];
  const eqCalls: Array<{ column: string; value: string }> = [];

  const client = {
    from: vi.fn((table: string) => ({
      upsert: vi.fn(async (payload: unknown, upsertOptions: unknown) => {
        events.push(`${table}:upsert`);
        upserts.push({ table, payload, options: upsertOptions });
        return {
          error:
            table === "widget_configs"
              ? (options.widgetError ?? null)
              : null,
        };
      }),
      update: vi.fn((payload: unknown) => {
        events.push(`${table}:update`);
        updates.push({ table, payload });
        return {
          eq: vi.fn(async (column: string, value: string) => {
            events.push(`${table}:eq`);
            eqCalls.push({ column, value });
            return { error: options.businessError ?? null };
          }),
        };
      }),
    })),
  } as unknown as SaveClient;

  return { client, events, upserts, updates, eqCalls };
}

describe("AIPersonalityForm primary goal boundary", () => {
  it("hides the SMS response delay while keeping widget customization for Chat Only", () => {
    const markup = renderToStaticMarkup(
      <AIPersonalityForm
        businessId="business-1"
        businessName="Example Business"
        initialPrimaryGoal="book"
        initialGoalUrl={null}
        showSmsResponseDelay={false}
        nextOnboardingStep="review_submit"
        onNext={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(markup).not.toContain("SMS Response Delay");
    expect(markup).toContain("Widget Welcome Message");
  });

  it("renders the exact goal copy first, with no NULL default or suggestion", () => {
    const markup = renderForm(null);
    const positions = AUTHORITATIVE_COPY.map((copy) =>
      markup.indexOf(renderedCopy(copy))
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions[0]).toBeLessThan(
      markup.indexOf("Customize your AI assistant")
    );
    expect(primaryGoalInput(markup, "book")).not.toContain('checked=""');
    expect(primaryGoalInput(markup, "signup")).not.toContain('checked=""');
    expect(submitButton(markup)).toContain('disabled=""');
  });

  it.each([
    ["book", "book"],
    ["signup", "signup"],
  ] as const)("rehydrates only the stored %s selection", (goal, checkedGoal) => {
    const markup = renderForm(goal, "https://example.com/signup");
    const otherGoal = checkedGoal === "book" ? "signup" : "book";

    expect(primaryGoalInput(markup, checkedGoal)).toContain('checked=""');
    expect(primaryGoalInput(markup, otherGoal)).not.toContain('checked=""');
  });

  it.each(["quote", "callback"] as const)(
    "does not coerce the legacy %s goal into a v1 selection",
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
    "not a url",
    "https:///path",
    "https://example.com/a path",
    `https://example.com/${"a".repeat(2030)}`,
  ])("blocks Next for invalid signup URL %s", (goalUrl) => {
    expect(submitButton(renderForm("signup", goalUrl))).toContain(
      'disabled=""'
    );
  });

  it.each([
    "https://example.com/path",
    "https://example.com/path?camp=summer",
    "https://example.com/path#signup",
  ])("enables Next for valid signup URL %s", (goalUrl) => {
    expect(submitButton(renderForm("signup", goalUrl))).not.toContain(
      'disabled=""'
    );
  });

  it("allows book without validating or deleting the retained URL", () => {
    const retainedUrl = `https://example.com/${"a".repeat(2030)}`;

    expect(submitButton(renderForm("book", retainedUrl))).not.toContain(
      'disabled=""'
    );
  });

  it("keeps the shared AI Settings body byte-identical across NULL and book", () => {
    expect(sharedAiSettingsBody(renderForm(null))).toBe(
      sharedAiSettingsBody(renderForm("book"))
    );
  });
});

describe("saveAIPersonalitySettings", () => {
  it("stores the no-SMS review successor for Chat Only", async () => {
    const writes = makeSaveClient();

    await saveAIPersonalitySettings({
      supabase: writes.client,
      businessId: "business-1",
      data: dataFor("book", ""),
      onNext: vi.fn(),
      nextOnboardingStep: "review_submit",
      now: () => "2026-08-11T12:00:00.000Z",
    });

    expect(writes.updates[0]?.payload).toMatchObject({
      onboarding_step: "review_submit",
    });
  });

  it("writes signup goal and URL together before advancing", async () => {
    const writes = makeSaveClient();
    const onNext = vi.fn(() => {
      writes.events.push("next");
    });

    await saveAIPersonalitySettings({
      supabase: writes.client,
      businessId: "business-1",
      data: dataFor("signup", "  https://example.com/signup?camp=1#form  "),
      onNext,
      now: () => "2026-08-11T12:00:00.000Z",
    });

    expect(writes.updates).toEqual([
      {
        table: "businesses",
        payload: {
          primary_goal: "signup",
          goal_url: "https://example.com/signup?camp=1#form",
          onboarding_step: "legal_verification",
          onboarding_last_saved_at: "2026-08-11T12:00:00.000Z",
        },
      },
    ]);
    expect(writes.eqCalls).toEqual([
      { column: "id", value: "business-1" },
    ]);
    expect(writes.events).toEqual([
      "ai_settings:upsert",
      "widget_configs:upsert",
      "businesses:update",
      "businesses:eq",
      "next",
    ]);
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("writes book without deleting the retained goal_url", async () => {
    const writes = makeSaveClient();

    await saveAIPersonalitySettings({
      supabase: writes.client,
      businessId: "business-1",
      data: dataFor("book", "https://example.com/retained"),
      onNext: vi.fn(),
      now: () => "2026-08-11T12:00:00.000Z",
    });

    expect(writes.updates[0]?.payload).toEqual({
      primary_goal: "book",
      onboarding_step: "legal_verification",
      onboarding_last_saved_at: "2026-08-11T12:00:00.000Z",
    });
    expect(writes.updates[0]?.payload).not.toHaveProperty("goal_url");
  });

  it("does not advance when the required business write fails", async () => {
    const writes = makeSaveClient({
      businessError: { message: "business update failed" },
    });
    const onNext = vi.fn();

    await expect(
      saveAIPersonalitySettings({
        supabase: writes.client,
        businessId: "business-1",
        data: dataFor("book", "https://example.com/retained"),
        onNext,
      })
    ).rejects.toEqual({ message: "business update failed" });

    expect(writes.events).toEqual([
      "ai_settings:upsert",
      "widget_configs:upsert",
      "businesses:update",
      "businesses:eq",
    ]);
    expect(onNext).not.toHaveBeenCalled();
  });
});


describe("booking onboarding configuration", () => {
  it("requires explicit booking details before advancing", async () => {
    const writes = makeSaveClient();
    const onNext = vi.fn();
    await expect(saveAIPersonalitySettings({ supabase: writes.client, businessId: "business-1", data: { ...dataFor("book", ""), booking_enabled: true }, onNext })).rejects.toThrow("Choose and save booking details");
    expect(onNext).not.toHaveBeenCalled();
    expect(writes.events).toEqual([]);
  });
  it("preserves existing service overrides and saves the expected revision", async () => {
    const writes = makeSaveClient();
    const services = [{ serviceId: "service", setting: { mode: "unavailable" } }];
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ booking: { revision: 2, services } })).mockResolvedValueOnce(Response.json({ booking: { revision: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const data = { ...dataFor("book", ""), booking_enabled: true, booking_revision: 2, booking_details: { format: "phone_callback" as const, label: "Estimate", durationMinutes: 30, businessAddress: null } };
      await saveAIPersonalitySettings({ supabase: writes.client, businessId: "business-1", data, onNext: vi.fn() });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ expectedRevision: 2, services });
      expect(data.booking_revision).toBe(3);
    } finally { vi.unstubAllGlobals(); }
  });
});
