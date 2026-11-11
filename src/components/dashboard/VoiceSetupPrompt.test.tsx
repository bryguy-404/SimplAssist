import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OwnerVoiceSettings } from "@/lib/voice/ownerSettings";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/settings/OwnerVoiceSettings", () => ({ saveOwnerVoiceSettings: vi.fn() }));
import VoiceSetupPrompt, { needsVoiceSetup } from "./VoiceSetupPrompt";
const settings: OwnerVoiceSettings = {
  visible: true, accessSource: "commercial", canEditPreferences: true, canEnableVoice: true,
  status: "ready", timezone: "UTC", preferences: { mode: "text", textFallbackEnabled: true, revision: 1 }, usage: null,
};
describe("voice activation setup prompt", () => {
  it("explains the default and links directly to activation without enabling voice", () => {
    const html = renderToStaticMarkup(<VoiceSetupPrompt settings={settings} />);
    expect(html).toContain('href="/settings#call-answering"');
    expect(html).toContain("not turned on yet");
    expect(html).toContain("Keep text follow-up");
    expect(html).toContain("with your phone carrier");
  });
  it.each([null, { ...settings, visible: false }, { ...settings, canEnableVoice: false },
    { ...settings, accessSource: "pilot" as const },
    { ...settings, preferences: { ...settings.preferences, mode: "voice" as const } },
    { ...settings, preferences: { ...settings.preferences, revision: 2 } },
  ])("does not prompt an unavailable, active, or intentionally configured account", (state) => {
    expect(needsVoiceSetup(state)).toBe(false);
    expect(renderToStaticMarkup(<VoiceSetupPrompt settings={state} />)).toBe("");
  });
});
