import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ConversationWithContact, InboxPage } from "./inbox";
import { normalizePhoneSearch } from "@/lib/phone/display";

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
async function readSingleSearch(businessId: string, ownerId: string, query: InboxRequest): Promise<InboxPage> {
  const cursor = decodeInboxCursor(query.cursor);
  const { data, error } = await supabaseAdmin.rpc("read_inbox_page", {
    p_business: businessId, p_owner: ownerId, p_folder: query.folder, p_channel: query.channel,
    p_search: query.search, p_cursor_time: cursor?.time ?? null, p_cursor_id: cursor?.id ?? null, p_focus: query.focus ?? null,
  });
  if (error || !data) throw new Error(error?.code === "42501" ? "inbox_access_denied" : "inbox_unavailable");
  return { ...data, next: data.next ? Buffer.from(JSON.stringify(cursorSchema.parse(data.next))).toString("base64url") : null };
}

function conversationTime(row: ConversationWithContact): string {
  return row.last_message_at ?? row.started_at ?? "1970-01-01T00:00:00Z";
}

// Postgres orders timestamps down to microseconds. Date alone loses the last three digits.
function microseconds(timestamp: string): number {
  const fraction = timestamp.match(/\.(\d+)/)?.[1] ?? "";
  return Date.parse(timestamp) * 1000 + Number(fraction.padEnd(6, "0").slice(3, 6));
}

async function countSearchMatches(
  businessId: string, ownerId: string, query: InboxRequest, folder: InboxPage["folder"], digits: string,
): Promise<number> {
  // Both terms are phone-shaped here. Quote them so punctuation is literal in PostgREST.
  const filters = [query.search, digits].flatMap(term => [
    `name.ilike."*${term}*"`, `phone_number.like."*${term}*"`,
  ]);
  let countQuery = supabaseAdmin.from("conversations")
    .select("id, contact:contacts!inner(), business:businesses!inner()", { count: "exact", head: true })
    .eq("business_id", businessId).eq("contact.business_id", businessId)
    .eq("business.owner_id", ownerId).is("business.deleted_at", null)
    .or(filters.join(","), { referencedTable: "contact" });
  countQuery = folder === "spam" ? countQuery.neq("spam_state", "inbox") : countQuery.eq("spam_state", "inbox");
  if (query.channel !== "all") countQuery = countQuery.eq("channel", query.channel);
  const { count, error } = await countQuery;
  if (error || count === null) throw new Error("inbox_unavailable");
  return count;
}

export async function readInboxPage(businessId: string, ownerId: string, query: InboxRequest): Promise<InboxPage> {
  const digits = normalizePhoneSearch(query.search);
  if (digits === query.search) return readSingleSearch(businessId, ownerId, query);

  // A search such as "7-11" can match both a literal name and digits in a phone.
  const [literal, numeric] = await Promise.all([
    readSingleSearch(businessId, ownerId, query),
    readSingleSearch(businessId, ownerId, { ...query, search: digits }),
  ]);
  if (!literal.total) return numeric;
  if (!numeric.total) return literal;

  const unique = new Map([...literal.conversations, ...numeric.conversations].map(row => [row.id, row]));
  const ordered = Array.from(unique.values()).sort((a, b) =>
    microseconds(conversationTime(b)) - microseconds(conversationTime(a)) || b.id.localeCompare(a.id),
  );
  const conversations = ordered.slice(0, 100);
  const last = conversations[conversations.length - 1];
  const hasMore = ordered.length > conversations.length || literal.next || numeric.next;
  const total = !query.cursor && !literal.next && !numeric.next
    ? unique.size
    : await countSearchMatches(businessId, ownerId, query, literal.folder, digits);
  const next = hasMore && last
    ? Buffer.from(JSON.stringify({ time: conversationTime(last), id: last.id })).toString("base64url")
    : null;
  return { ...literal, conversations, total, next };
}
