import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { InboxPage } from "./inbox";

const cursorSchema = z.object({ time: z.iso.datetime({ offset: true }), id: z.string().uuid() });
export const inboxQuerySchema = z.object({
  folder: z.enum(["inbox", "spam"]).default("inbox"),
  channel: z.enum(["all", "sms", "web_chat", "voice"]).default("all"),
  search: z.string().trim().max(120).default(""),
  cursor: z.string().max(300).optional(),
  focus: z.string().uuid().optional(),
});
export type InboxRequest = z.infer<typeof inboxQuerySchema>;
export function decodeInboxCursor(value?: string) {
  if (!value) return null;
  try { return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString())); }
  catch { throw new Error("inbox_invalid_cursor"); }
}
export async function readInboxPage(businessId: string, ownerId: string, query: InboxRequest): Promise<InboxPage> {
  const cursor = decodeInboxCursor(query.cursor);
  const { data, error } = await supabaseAdmin.rpc("read_inbox_page", {
    p_business: businessId, p_owner: ownerId, p_folder: query.folder, p_channel: query.channel,
    p_search: query.search, p_cursor_time: cursor?.time ?? null, p_cursor_id: cursor?.id ?? null, p_focus: query.focus ?? null,
  });
  if (error || !data) throw new Error(error?.code === "42501" ? "inbox_access_denied" : "inbox_unavailable");
  return { ...data, next: data.next ? Buffer.from(JSON.stringify(cursorSchema.parse(data.next))).toString("base64url") : null };
}
