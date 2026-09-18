import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AISettings } from "@/types/database";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(),
}));

import AISettingsForm, { buildAISettingsUpdates } from "./AISettingsForm";

const SETTINGS: AISettings = {
  id: "settings-1",
  business_id: "business-1",
  tone: "friendly",
  business_voice: "we",
  language: "en",
  sms_response_delay_seconds: 0,
  guardrails: [],
  booking_enabled: false,
  booking_mode: "collect_info",
  created_at: "2026-08-03T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:00.000Z",
};

describe("AISettingsForm Google Calendar connection state", () => {
  it("omits only the SMS response-delay surface for Chat Only", () => {
    const html = renderToStaticMarkup(
      <AISettingsForm
        settings={SETTINGS}
        businessName="Example Business"
        businessId="business-1"
        showSmsResponseDelay={false}
        fullSuiteAvailable={false}
      />
    );

    expect(html).not.toContain("Response Behavior");
    expect(html).not.toContain("SMS Response Delay");
    expect(html).toContain("Tone &amp; Voice");
    expect(html).toContain("Web Chat Greeting");
    expect(html).toContain("Google Calendar");
  });

  it("omits the entire booking and Google Calendar card when the goal does not use Calendar", () => {
    const html = renderToStaticMarkup(
      <AISettingsForm
        settings={{
          ...SETTINGS,
          booking_enabled: true,
          booking_mode: "schedule_direct",
        }}
        businessName="Example Business"
        businessId="business-1"
        calendarEmail="owner@example.test"
        calendarConnected
        canUseCalendar
        calendarGoalAvailable={false}
        fullSuiteAvailable={false}
      />
    );

    expect(html).not.toContain('data-booking-card="true"');
    expect(html).not.toContain("Enable Appointment Booking");
    expect(html).not.toContain("Google Calendar");
    expect(html).not.toContain("Connect Google Calendar");
    expect(html).not.toContain("Disconnect");
    expect(html).toContain("Tone &amp; Voice");
    expect(html).toContain("Response Behavior");
    expect(html).toContain("Guardrails");
  });

  it("keeps default and explicit goal-available markup identical", () => {
    const defaultMarkup = renderToStaticMarkup(
      <AISettingsForm
        settings={SETTINGS}
        businessName="Example Business"
        businessId="business-1"
        fullSuiteAvailable={false}
      />
    );
    const explicitMarkup = renderToStaticMarkup(
      <AISettingsForm
        settings={SETTINGS}
        businessName="Example Business"
        businessId="business-1"
        calendarGoalAvailable
        fullSuiteAvailable={false}
      />
    );

    expect(explicitMarkup).toBe(defaultMarkup);
    expect(defaultMarkup).toContain('data-booking-card="true"');
    expect(defaultMarkup).toContain("Enable Appointment Booking");
  });

  it("excludes only booking fields from signup-goal saves", () => {
    const data: Parameters<typeof buildAISettingsUpdates>[0] = {
      tone: "professional",
      business_voice: "business_name",
      language: "both",
      sms_response_delay_seconds: 15,
      guardrails_text: "Never promise a fixed price",
      booking_enabled: true,
      booking_mode: "schedule_direct",
    };
    const commonPolicy = {
      canCustomizeAi: true,
      canUseCalendar: true,
      canUseGuardrails: true,
    };

    const signupUpdates = buildAISettingsUpdates(data, {
      ...commonPolicy,
      calendarGoalAvailable: false,
    });

    expect(signupUpdates).toEqual({
      language: "both",
      tone: "professional",
      business_voice: "business_name",
      sms_response_delay_seconds: 15,
      guardrails: ["Never promise a fixed price"],
    });
    expect(signupUpdates).not.toHaveProperty("booking_enabled");
    expect(signupUpdates).not.toHaveProperty("booking_mode");

    expect(buildAISettingsUpdates(data, commonPolicy)).toEqual({
      language: "both",
      tone: "professional",
      business_voice: "business_name",
      sms_response_delay_seconds: 15,
      booking_enabled: true,
      booking_mode: "schedule_direct",
      guardrails: ["Never promise a fixed price"],
    });
  });

  it("presents booking as a dedicated card with the existing Google Calendar icon", () => {
    const html = renderToStaticMarkup(
      <AISettingsForm
        settings={SETTINGS}
        businessName="Example Business"
        businessId="business-1"
        calendarConnected={false}
        fullSuiteAvailable={false}
      />
    );

    const bookingCard = html.match(
      /<section[^>]*data-booking-card="true"[\s\S]*?<\/section>/
    )?.[0];

    expect(bookingCard).toBeDefined();
    expect(bookingCard).toContain('data-google-calendar-icon="true"');
    expect(bookingCard).toContain('role="img"');
    expect(bookingCard).toContain('aria-label="Google Calendar"');
    expect(bookingCard).toContain(
      "/marketing/technology/google-calendar.svg"
    );
    expect(bookingCard).toContain("Booking");
    expect(bookingCard).toContain("Let your AI handle appointment scheduling.");
    expect(bookingCard).toContain("Enable Appointment Booking");
    expect(bookingCard).toContain('aria-pressed="false"');
    expect(bookingCard).toContain("rounded-[22px]");
    expect(bookingCard).not.toContain("Guardrails");
  });

  it("shows the optional connection in collect-info mode when booking is enabled", () => {
    const html = renderToStaticMarkup(
      <AISettingsForm
        settings={{
          ...SETTINGS,
          booking_enabled: true,
          booking_mode: "collect_info",
        }}
        businessName="Example Business"
        businessId="business-1"
        calendarConnected={false}
        fullSuiteAvailable={false}
      />
    );

    expect(html).toContain("Google Calendar");
    expect(html).toContain(
      "optional — connect to enable direct scheduling"
    );
    expect(html).toContain("Connect Google Calendar");
  });

  it("keeps the current connection presentation in direct mode", () => {
    const html = renderToStaticMarkup(
      <AISettingsForm
        settings={{
          ...SETTINGS,
          booking_enabled: true,
          booking_mode: "schedule_direct",
        }}
        businessName="Example Business"
        businessId="business-1"
        calendarConnected={false}
        fullSuiteAvailable={false}
      />
    );

    expect(html).toContain("Direct scheduling");
    expect(html).toContain("Google Calendar");
    expect(html).toContain("Connect Google Calendar");
    expect(html).not.toContain(
      "optional — connect to enable direct scheduling"
    );
  });

  it("hides the connection when appointment booking is disabled", () => {
    const html = renderToStaticMarkup(
      <AISettingsForm
        settings={SETTINGS}
        businessName="Example Business"
        businessId="business-1"
        calendarConnected={false}
        fullSuiteAvailable={false}
      />
    );

    expect(html).not.toContain("Connect Google Calendar");
    expect(html).not.toContain(
      "optional — connect to enable direct scheduling"
    );
  });

  it("preserves disconnect for a saved token whose google_email is null", () => {
    const html = renderToStaticMarkup(
      <AISettingsForm
        settings={SETTINGS}
        businessName="Example Business"
        businessId="business-1"
        calendarEmail={null}
        calendarConnected
        canUseCalendar={false}
        fullSuiteAvailable={false}
      />
    );

    expect(html).toContain("Connected");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Connect Google Calendar");
  });
});

describe("AISettingsForm guardrail saving", () => {
  const policy = {
    canCustomizeAi: true,
    canUseCalendar: false,
    canUseGuardrails: true,
  };
  const formData = {
    ...SETTINGS,
    guardrails_text: "",
  };

  it("saves typed rules directly, including multiline pastes and blank lines", () => {
    const updates = buildAISettingsUpdates({
      ...formData,
      guardrails_text: "  Use the approved $10 Chat Only price.\r\n\r\n Describe Full Suite voice accurately.  \n",
    }, policy);

    expect(updates.guardrails).toEqual([
      "Use the approved $10 Chat Only price.",
      "Describe Full Suite voice accurately.",
    ]);
  });

  it("loads saved rules into the editable box and keeps them on an unchanged save", () => {
    const rules = ["Use approved prices.", "Never promise discounts."];
    const html = renderToStaticMarkup(
      <AISettingsForm
        settings={{ ...SETTINGS, guardrails: rules }}
        businessName="Example Business"
        fullSuiteAvailable
      />
    );

    expect(html).toMatch(/<textarea[^>]*>Use approved prices\.\nNever promise discounts\.<\/textarea>/);
    expect(html).not.toContain("+ Add rules");
    expect(buildAISettingsUpdates({
      ...formData,
      guardrails_text: rules.join("\n"),
    }, policy).guardrails).toEqual(rules);
  });

  it("saves an empty list when the owner clears the box", () => {
    expect(buildAISettingsUpdates({
      ...formData,
      guardrails_text: " \n\n ",
    }, policy).guardrails).toEqual([]);
  });

  it("does not overwrite saved guardrails when the feature is locked", () => {
    const updates = buildAISettingsUpdates({
      ...formData,
      guardrails_text: "Changed while access is unavailable",
    }, { ...policy, canUseGuardrails: false });

    expect(updates).not.toHaveProperty("guardrails");
    const html = renderToStaticMarkup(
      <AISettingsForm
        settings={{ ...SETTINGS, guardrails: ["Keep this saved rule."] }}
        businessName="Example Business"
        canUseGuardrails={false}
        fullSuiteAvailable
      />
    );
    expect(html).toMatch(/<textarea[^>]*disabled[^>]*>Keep this saved rule\.<\/textarea>/);
  });
});

describe("AISettingsForm advanced guardrails plan notice", () => {
  function renderNotice({
    fullSuiteAvailable,
    planActive = true,
  }: {
    fullSuiteAvailable: boolean;
    planActive?: boolean;
  }) {
    return renderToStaticMarkup(
      <AISettingsForm
        settings={SETTINGS}
        businessName="Example Business"
        canUseGuardrails={false}
        planActive={planActive}
        fullSuiteAvailable={fullSuiteAvailable}
      />
    );
  }

  it("hides the active lower-tier Full Suite notice while the plan is unavailable", () => {
    const html = renderNotice({ fullSuiteAvailable: false });

    expect(html).not.toContain("Advanced guardrails require the");
    expect(html).not.toContain("Full Suite plan");
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });

  it("restores the exact active lower-tier Full Suite notice when the plan is available", () => {
    const html = renderNotice({ fullSuiteAvailable: true });

    expect(html).toContain("Advanced guardrails require the");
    expect(html).toContain("Full Suite plan");
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });

  it("preserves the neutral inactive-subscription notice while Full Suite is unavailable", () => {
    const html = renderNotice({
      fullSuiteAvailable: false,
      planActive: false,
    });

    expect(html).toContain("Your subscription is inactive. Reactivate it in");
    expect(html).toContain(">Billing</a>");
    expect(html).not.toContain("Full Suite plan");
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });
});
