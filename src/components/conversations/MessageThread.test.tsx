import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationWithContact } from "@/app/(dashboard)/conversations/page";
import type { Message } from "@/types/database";

vi.mock("@/lib/supabase/client", () => ({ createBrowserClient: () => ({}) }));
import { MessageThread } from "./MessageThread";

const conversation: ConversationWithContact = {
  id: "call",
  business_id: "business",
  contact_id: "contact",
  channel: "voice",
  status: "closed",
  is_ai_handling: false,
  started_at: "2026-09-17T12:00:00Z",
  last_message_at: "2026-09-17T12:01:00Z",
  contact: {
    id: "contact",
    name: "Alex",
    phone_number: "+15555550101",
    email: null,
  },
};
const access = {
  businessId: "business",
  smsReady: true,
  smsBlockReason: null,
  canUseManualSms: true,
  canUseAiSms: true,
  canUseWebChat: true,
};

describe("conversation channel display", () => {
  it("uses a dedicated read-only transcript for voice without an empty text-message placeholder", () => {
    const html = renderToStaticMarkup(
      <MessageThread conversation={conversation} {...access} />,
    );
    expect(html).toContain("Loading transcript");
    expect(html).toContain("Loading call review");
    expect(html).toContain("This voice transcript is read-only.");
    expect(html).not.toMatch(
      /No messages in this conversation yet|<textarea|Take Over|Let AI Handle/,
    );
  });
  it.each(["sms", "web_chat"] as const)(
    "preserves %s message bubbles",
    (channel) => {
      const message: Message = {
        id: "message",
        conversation_id: "call",
        business_id: "business",
        role: "assistant",
        channel,
        content: "Here is your information.",
        created_at: "2026-09-17T12:01:00Z",
        provider_event_id: null,
        ai_reply_reservation_id: null,
        ai_reply_reservation_attempt_token: null,
      };
      const html = renderToStaticMarkup(
        <MessageThread
          conversation={{ ...conversation, channel, status: "active" }}
          {...access}
          demoMessages={[message]}
        />,
      );
      expect(html).toContain("Here is your information.");
      expect(html).not.toContain("Loading transcript");
    },
  );
  it("does not offer a send path when an SMS conversation has only a synthetic session identity", () => {
    const html = renderToStaticMarkup(
      <MessageThread
        conversation={{
          ...conversation,
          channel: "sms",
          contact: {
            ...conversation.contact!,
            source_channel: "web_chat",
            phone_number: "session_unverified",
            provided_phone_number: null,
          },
        }}
        {...access}
      />,
    );
    expect(html).toContain(
      "This conversation has no valid customer phone number.",
    );
    expect(html).not.toContain('placeholder="Type a message..."');
  });
  it("offers SMS replies for the captured customer callback number without treating a session ID as a phone", () => {
    const html = renderToStaticMarkup(
      <MessageThread
        conversation={{
          ...conversation,
          channel: "sms",
          contact: {
            ...conversation.contact!,
            source_channel: "web_chat",
            phone_number: "session_unverified",
            provided_phone_number: "(555) 555-0102",
          },
        }}
        {...access}
      />,
    );
    expect(html).toContain('placeholder="Type a message..."');
    expect(html).not.toContain(
      "This conversation has no valid customer phone number.",
    );
  });
});
