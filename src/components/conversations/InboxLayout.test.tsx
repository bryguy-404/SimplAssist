import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConversationWithContact, InboxPage } from "@/lib/conversations/inbox";
vi.mock("@/lib/supabase/client", () => ({ createBrowserClient: () => ({}) }));
import { InboxLayout } from "./InboxLayout";

const item: ConversationWithContact = {
  id: "sms", business_id: "business", contact_id: "contact", channel: "sms", status: "active",
  is_ai_handling: true, started_at: "2026-11-20T14:00:00Z", last_message_at: "2026-11-20T14:00:00Z",
  contact: { id: "contact", name: "Caller", phone_number: "+15745550100", email: null },
  inbox_folder: "no_reply", inbox_reason: "text_sent", inbox_item_id: "sms",
  missed_calls: [{ at: "2026-11-20T14:00:00Z", origin: "missed", conversation_id: "voice" }],
};
const page: InboxPage = { folder: "no_reply", counts: { inbox: 1, no_reply: 1, spam: 0 }, conversations: [item], selected: item, total: 1, next: null };
describe("conversation folders", () => {
  it("renders all folders, the original call, callback link, and an owner restore action", () => {
    const html = renderToStaticMarkup(<InboxLayout businessId="business" conversations={[item]} initialPage={page} smsReady smsBlockReason={null} />);
    for (const content of ["Inbox","No reply yet","Spam","Move to Inbox","Missed call · Follow-up text sent","tel:+15745550100","/conversations?conversation=voice","Call + SMS"]) {
      expect(html).toContain(content);
    }
  });
  it("shows a focused grouped call with a route back to the SMS thread", () => {
    const voice: ConversationWithContact = { ...item, id: "voice", channel: "voice", status: "closed", missed_calls: [] };
    const html = renderToStaticMarkup(<InboxLayout businessId="business" conversations={[item]} initialPage={{ ...page, selected: voice }} smsReady smsBlockReason={null} />);
    expect(html).toContain("/conversations?conversation=sms");
  });
});
