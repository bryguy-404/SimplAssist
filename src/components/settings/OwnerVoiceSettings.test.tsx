import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OwnerVoiceSettings as VoiceSettings } from "@/lib/voice/ownerSettings";
import OwnerVoiceSettings, {
  OwnerVoiceSettingsContent, VoiceMinuteUsage, formatVoiceMinutes,
  refreshOwnerVoiceSettings, submitOwnerVoiceSettings, voiceUsageLevel,
} from "./OwnerVoiceSettings";

function fixture(): VoiceSettings {
  return {
    visible: true, accessSource: "commercial", canEditPreferences: true, canEnableVoice: true,
    status: "ready", timezone: "America/New_York",
    preferences: { mode: "text", textFallbackEnabled: true, revision: 4 },
    usage: {
      kind: "monthly", periodState: "current", includedSeconds: 6000, usedSeconds: 1200,
      heldSeconds: 600, availableSeconds: 4200,
      resetsAt: "2026-10-01T00:00:00Z", reconciling: false,
    },
  };
}
const response = (voice: VoiceSettings) => Response.json({ voice });
const update = { mode: "voice" as const, textFallbackEnabled: true, expectedRevision: 4 };

describe("owner voice settings", () => {
  it("renders nothing for a closed ordinary account or unknown initial visibility", () => {
    const voice = fixture(); voice.visible = false;
    expect(renderToStaticMarkup(<OwnerVoiceSettings initialSettings={voice} />)).toBe("");
    expect(renderToStaticMarkup(<OwnerVoiceSettings initialSettings={null} />)).toBe("");
  });

  it("separates used, held and available minutes and shows the exact local reset", () => {
    const html = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={fixture()} />);
    expect(html).toContain("Included"); expect(html).toContain("Used");
    expect(html).toContain("Held"); expect(html).toContain("Available");
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain("20 minutes used; 10 minutes held");
    expect(html).toContain("Sep 30, 2026, 8:00 PM");
    expect(html).toContain("(America/New_York)");
    expect(html).toContain('dateTime="2026-10-01T00:00:00Z"');
    expect(html).toContain("Your ordinary SMS allowance and rates still apply.");
    expect(html).toContain("Extra voice minutes are not purchased or charged automatically.");
    expect(html).not.toMatch(/Upgrade|\$65|Buy|Enable overages/);
  });

  it("keeps pilot lifetime accounting read-only without monthly controls", () => {
    const voice = fixture();
    voice.accessSource = "pilot";
    voice.usage = { ...voice.usage!, kind: "pilot_lifetime", includedSeconds: 12000, resetsAt: null };
    const html = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={voice} />);
    expect(html).toContain("Private pilot · lifetime minutes");
    expect(html).toContain("Lifetime budget");
    expect(html).toContain('aria-valuemax="200"');
    expect(html).toContain("does not reset each month");
    expect(html).not.toMatch(/<form|<input|Save call settings|Manage call settings|Resets /);
  });

  it.each([
    ["rollout_closed", "not available for new calls"],
    ["plan_required", "current plan does not include voice"],
    ["payment_required", "subscription and payment"],
    ["exhausted", "fewer than one minute"],
    ["temporarily_unavailable", "temporarily unavailable"],
  ] as const)("explains %s and prevents selecting voice", (status, copy) => {
    const voice = fixture(); voice.status = status; voice.canEnableVoice = false;
    const html = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={voice}
      draft={{ mode: "voice", textFallbackEnabled: true }} />);
    const radio = html.match(/<input[^>]*value="voice"[^>]*>/)?.[0];
    const button = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0];
    expect(html).toContain(copy);
    expect(radio).toContain('disabled=""');
    expect(button).toContain('disabled=""');
  });

  it("lets a downgraded owner turn existing voice off and retains history access", () => {
    const voice = fixture(); voice.preferences.mode = "voice";
    voice.status = "plan_required"; voice.canEnableVoice = false;
    const html = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={voice}
      draft={{ mode: "text", textFallbackEnabled: false }} />);
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(html).toContain('href="/conversations"');
    expect(html).toContain("previous call history remains available");
  });

  it.each([
    "rollout_closed", "plan_required", "payment_required", "exhausted", "temporarily_unavailable",
  ] as const)("lets an existing voice owner disable text fallback during %s", (status) => {
    const voice = fixture();
    voice.preferences.mode = "voice";
    voice.status = status;
    voice.canEnableVoice = false;
    const html = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={voice}
      draft={{ mode: "voice", textFallbackEnabled: false }} />);
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(html.match(/<input[^>]*value="voice"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).not.toContain('disabled=""');
    const unchanged = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={voice} />);
    expect(unchanged.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it.each([
    [4799, 0, "normal"],
    [4200, 600, "warning"],
    [5100, 600, "critical"],
    [5970, 0, "exhausted"],
  ] as const)("uses held minutes for the warning boundary (%s + %s)", (used, held, level) => {
    const usage = { ...fixture().usage!, usedSeconds: used, heldSeconds: held, availableSeconds: 6000 - used - held };
    expect(voiceUsageLevel(usage)).toBe(level);
    const html = renderToStaticMarkup(<VoiceMinuteUsage settings={{ ...fixture(), usage }} />);
    if (level === "warning") expect(html).toContain("At least 80%");
    if (level === "critical") expect(html).toContain("At least 95%");
    if (level === "exhausted") expect(html).toContain("Fewer than one minute");
  });

  it("distinguishes uncertain holds from usage and handles an unavailable allowance", () => {
    const voice = fixture(); voice.usage!.reconciling = true;
    let html = renderToStaticMarkup(<VoiceMinuteUsage settings={voice} />);
    expect(html).toContain("uncertain time remains held");
    expect(html).toContain("separate from used minutes");
    voice.usage = null;
    html = renderToStaticMarkup(<VoiceMinuteUsage settings={voice} />);
    expect(html).toContain("No usage estimate is shown");
    expect(html).not.toContain("progressbar");
  });

  it("never invents a reset date when timing is unavailable", () => {
    const voice = fixture(); voice.usage!.resetsAt = null;
    expect(renderToStaticMarkup(<VoiceMinuteUsage settings={voice} />)).toContain("No new allowance is assumed");
    voice.usage!.resetsAt = "2026-10-01T00:00:00Z"; voice.timezone = "invalid-zone";
    expect(renderToStaticMarkup(<VoiceMinuteUsage settings={voice} />)).toContain("No new allowance is assumed");
    expect(formatVoiceMinutes(59)).toBe("0.98");
  });

  it("labels an ended cycle as history without promising available minutes or a future reset", () => {
    const voice = fixture();
    voice.usage = { ...voice.usage!, periodState: "ended", usedSeconds: 6000, heldSeconds: 0, availableSeconds: 0 };
    const html = renderToStaticMarkup(<VoiceMinuteUsage settings={voice} />);
    expect(html).toContain("previous billing period");
    expect(html).toContain("Unused");
    expect(html).toContain("retained usage totals");
    expect(html).toContain("No new allowance is available yet");
    expect(html).not.toMatch(/Resets |Available|At least 80%|At least 95%|Fewer than one minute/);
    expect(voiceUsageLevel(voice.usage)).toBe("normal");
  });

  it("billing usage has no editable controls and links back to settings", () => {
    const html = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={fixture()} variant="usage" />);
    expect(html).toContain("Voice usage");
    expect(html).toContain('href="/settings"');
    expect(html).not.toMatch(/<form|<input|Save call settings/);
  });

  it("shows refresh, save, error and saved feedback accessibly", () => {
    expect(renderToStaticMarkup(<OwnerVoiceSettingsContent settings={fixture()} busy="refreshing" />)).toContain("Refreshing…");
    expect(renderToStaticMarkup(<OwnerVoiceSettingsContent settings={fixture()} busy="saving" />)).toContain("Saving…");
    const error = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={fixture()} feedback={{ kind: "error", text: "Refresh required" }} />);
    expect(error).toContain('role="alert"'); expect(error).toContain("Refresh required");
    const saved = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={fixture()} feedback={{ kind: "success", text: "Call settings saved." }} />);
    expect(saved).toContain('role="status"'); expect(saved).toContain("Call settings saved.");
  });

  it("describes fallback off without suggesting an automatic text or purchase", () => {
    const voice = fixture(); voice.preferences.textFallbackEnabled = false;
    const html = renderToStaticMarkup(<OwnerVoiceSettingsContent settings={voice} />);
    expect(html).toContain("voicemail path without a generic text");
    expect(html).toContain("Changes apply to new calls");
  });
});

describe("voice settings requests", () => {
  it("serializes only API fields when the UI draft carries the saved revision", async () => {
    const current = fixture();
    const input = { ...current.preferences, textFallbackEnabled: false, expectedRevision: current.preferences.revision };
    expect(input.revision).toBe(4);
    const saved = fixture();
    saved.preferences = { mode: input.mode, textFallbackEnabled: input.textFallbackEnabled, revision: 5 };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      expect(body).toEqual({ mode: "text", textFallbackEnabled: false, expectedRevision: 4 });
      return response(saved);
    });
    const result = await submitOwnerVoiceSettings(input, fetcher);
    expect(result.saved).toBe(true);
    expect(result.settings?.preferences.revision).toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("saves fallback-only changes without switching an unavailable account to primary text", async () => {
    const saved = fixture();
    saved.canEnableVoice = false;
    saved.status = "rollout_closed";
    saved.preferences = { mode: "voice", textFallbackEnabled: false, revision: 5 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(saved));
    const input = { mode: "voice" as const, textFallbackEnabled: false, expectedRevision: 4 };
    const result = await submitOwnerVoiceSettings(input, fetcher);
    expect(result.saved).toBe(true);
    expect(result.settings?.preferences).toEqual(saved.preferences);
    expect(result.settings?.canEnableVoice).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(input);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses the returned saved preferences and balance with the original revision", async () => {
    const saved = fixture(); saved.preferences = { mode: "voice", textFallbackEnabled: false, revision: 5 };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(saved));
    const result = await submitOwnerVoiceSettings(update, fetcher);
    expect(result.saved).toBe(true); expect(result.settings).toEqual(saved);
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe("/api/settings/voice");
    expect(request).toMatchObject({ method: "PATCH", cache: "no-store" });
    expect(JSON.parse(String(request?.body))).toEqual(update);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([403, 409])("refreshes stale access after %s without replaying the rejected write", async (status) => {
    const latest = fixture(); latest.canEnableVoice = false;
    latest.status = "rollout_closed"; latest.preferences.revision = 5;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status }))
      .mockResolvedValueOnce(response(latest));
    const result = await submitOwnerVoiceSettings(update, fetcher);
    expect(result.saved).toBe(false); expect(result.settings).toEqual(latest);
    expect(result.requiresRefresh).toBe(false);
    expect(fetcher.mock.calls.map(([, request]) => request?.method)).toEqual(["PATCH", "GET"]);
  });

  it("requires a successful refresh if stale access cannot be reloaded", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockRejectedValueOnce(new Error("network"));
    const result = await submitOwnerVoiceSettings(update, fetcher);
    expect(result).toMatchObject({ saved: false, settings: null, requiresRefresh: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry an uncertain network write or report it saved", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network"));
    const result = await submitOwnerVoiceSettings(update, fetcher);
    expect(result.saved).toBe(false); expect(result.settings).toBeNull();
    expect(result.message).toContain("Could not reach");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed balances rather than showing a false zero or saved result", async () => {
    const invalid = fixture(); invalid.usage!.availableSeconds = -1;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(invalid));
    await expect(refreshOwnerVoiceSettings(fetcher)).rejects.toThrow("could not be verified");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
  });
});
