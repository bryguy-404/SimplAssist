import { describe, expect, it } from "vitest";
import {
  getConversationAccessState,
  smsPlanLockedMessage,
} from "./accessState";

describe("getConversationAccessState", () => {
  it("keeps voice read-only even when all text permissions and the stored AI flag are enabled", () => {
    expect(getConversationAccessState({ channel: "voice", storedIsAiHandling: true, canUseManualSms: true, canUseAiSms: true, canUseWebChat: true })).toMatchObject({ canWrite: false, canToggleAi: false });
  });
  it("forces Starter SMS into writable Human mode despite a tampered AI flag", () => {
    expect(
      getConversationAccessState({
        channel: "sms",
        storedIsAiHandling: true,
        canUseManualSms: true,
        canUseAiSms: false,
        canUseWebChat: false,
      })
    ).toEqual({
      webChatLocked: false,
      smsPlanLocked: false,
      effectiveIsAiHandling: false,
      canToggleAi: false,
      canWrite: true,
    });
  });

  it("keeps Growth and Full manual takeover writable and reversible", () => {
    expect(
      getConversationAccessState({
        channel: "sms",
        storedIsAiHandling: false,
        canUseManualSms: true,
        canUseAiSms: true,
        canUseWebChat: true,
      })
    ).toMatchObject({
      effectiveIsAiHandling: false,
      canToggleAi: true,
      canWrite: true,
    });
  });

  it("disables manual composition while AI is handling an entitled conversation", () => {
    expect(
      getConversationAccessState({
        channel: "sms",
        storedIsAiHandling: true,
        canUseManualSms: true,
        canUseAiSms: true,
        canUseWebChat: true,
      })
    ).toMatchObject({
      effectiveIsAiHandling: true,
      canToggleAi: true,
      canWrite: false,
    });
  });

  it("makes canceled-plan SMS history readable but not writable", () => {
    expect(
      getConversationAccessState({
        channel: "sms",
        storedIsAiHandling: false,
        canUseManualSms: false,
        canUseAiSms: false,
        canUseWebChat: false,
      })
    ).toMatchObject({
      smsPlanLocked: true,
      effectiveIsAiHandling: false,
      canToggleAi: false,
      canWrite: false,
    });
  });

  it("makes downgraded web-chat history readable but not writable", () => {
    expect(
      getConversationAccessState({
        channel: "web_chat",
        storedIsAiHandling: true,
        canUseManualSms: true,
        canUseAiSms: false,
        canUseWebChat: false,
      })
    ).toMatchObject({
      webChatLocked: true,
      effectiveIsAiHandling: false,
      canToggleAi: false,
      canWrite: false,
    });
  });

  it("keeps entitled web chat AI-only because dashboard replies are not transported to visitors", () => {
    expect(
      getConversationAccessState({
        channel: "web_chat",
        storedIsAiHandling: false,
        canUseManualSms: true,
        canUseAiSms: true,
        canUseWebChat: true,
      })
    ).toMatchObject({
      webChatLocked: false,
      effectiveIsAiHandling: true,
      canToggleAi: false,
      canWrite: false,
    });
  });

  it("describes retained SMS history as excluded for an active no-SMS plan", () => {
    expect(smsPlanLockedMessage(false)).toBe(
      "SMS is not included in your current plan.",
    );
    expect(smsPlanLockedMessage(true)).toBe(
      "SMS sending is paused because this plan is inactive.",
    );
  });
});
