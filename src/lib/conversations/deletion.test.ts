import { describe, expect, it } from "vitest";
import { canDeleteConversation } from "./deletion";

const access = { canUseManualSms: true, canUseWebChat: true };

describe("inbox deletion eligibility", () => {
  it.each(["sms", "web_chat", "voice"] as const)("protects %s appointment history", (channel) => {
    expect(canDeleteConversation({ channel, status: "closed", has_bookings: true }, access)).toBe(false);
  });
  it("allows completed calls but keeps active calls protected", () => {
    expect(canDeleteConversation({ channel: "voice", status: "closed" }, access)).toBe(true);
    expect(canDeleteConversation({ channel: "voice", status: "active" }, access)).toBe(false);
    expect(canDeleteConversation({ channel: "voice", status: "handed_off" }, access)).toBe(false);
  });
  it("keeps unavailable text and chat history protected", () => {
    expect(canDeleteConversation({ channel: "sms", status: "closed" }, { ...access, canUseManualSms: false })).toBe(false);
    expect(canDeleteConversation({ channel: "web_chat", status: "closed" }, { ...access, canUseWebChat: false })).toBe(false);
  });
});
