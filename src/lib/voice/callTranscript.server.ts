import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  groupVoiceCallTranscript,
  type VoiceCallTranscript,
  type VoiceCallTranscriptFragment,
} from "./callTranscript";

const PAGE_SIZE = 500;
const MAX_FRAGMENTS = 5000;
const FRAGMENT_COLUMNS = "id,event_id,role,content,start_ms,end_ms";

/** Fresh workspace authorization is required before calling this loader. */
export async function loadVoiceCallTranscript(
  businessId: string,
  conversationId: string,
): Promise<VoiceCallTranscript | null> {
  const conversation = await supabaseAdmin.from("conversations")
    .select("id,business_id,channel").eq("id", conversationId)
    .eq("business_id", businessId).eq("channel", "voice").maybeSingle();
  if (conversation.error) throw unavailable();
  if (!conversation.data || conversation.data.id !== conversationId ||
    conversation.data.business_id !== businessId || conversation.data.channel !== "voice") return null;

  const session = await supabaseAdmin.from("voice_sessions")
    .select("id,business_id,conversation_id,status,ended_at,phone_ended_at")
    .eq("business_id", businessId).eq("conversation_id", conversationId)
    .eq("response_mode", "voice").maybeSingle();
  if (session.error) throw unavailable();
  if (!session.data || session.data.business_id !== businessId ||
    session.data.conversation_id !== conversationId) return null;
  const call = session.data;

  // Use a database timestamp, not this server's clock. Later arrivals appear on
  // refresh. This bounded read is not a transaction snapshot of a live call.
  const newest = await supabaseAdmin.from("voice_transcript_fragments")
    .select("received_at").eq("business_id", businessId).eq("session_id", call.id)
    .order("received_at", { ascending: false }).limit(1).maybeSingle();
  if (newest.error) throw unavailable();
  const fragments: VoiceCallTranscriptFragment[] = [];
  if (newest.data) {
    if (typeof newest.data.received_at !== "string" || !Number.isFinite(Date.parse(newest.data.received_at))) throw unavailable();
    let afterId: string | null = null;
    // UUID keysets cannot shift when late fragments have earlier audio times.
    // Fetch one extra row to distinguish an exact limit from a partial result.
    while (fragments.length <= MAX_FRAGMENTS) {
      const limit = Math.min(PAGE_SIZE, MAX_FRAGMENTS + 1 - fragments.length);
      let query = supabaseAdmin.from("voice_transcript_fragments")
        .select(FRAGMENT_COLUMNS).eq("business_id", businessId).eq("session_id", call.id)
        .lte("received_at", newest.data.received_at).order("id", { ascending: true });
      if (afterId !== null) query = query.gt("id", afterId);
      const page = await query.limit(limit);
      if (page.error) throw unavailable();
      const rows = page.data || [];
      const decoded = rows.map(decodeFragment);
      for (const fragment of decoded) {
        if (afterId !== null && fragment.id <= afterId) throw unavailable();
        afterId = fragment.id;
        fragments.push(fragment);
      }
      // A project may configure a lower row cap than the requested page size.
      // Only an empty page proves exhaustion; a short page still advances.
      if (rows.length === 0 || fragments.length > MAX_FRAGMENTS) break;
    }
  }
  return {
    conversationId,
    callInProgress: call.status !== "closed" && call.ended_at === null && call.phone_ended_at === null,
    turns: groupVoiceCallTranscript(fragments.slice(0, MAX_FRAGMENTS)),
    truncated: fragments.length > MAX_FRAGMENTS,
  };
}

function unavailable(): Error {
  return new Error("voice_transcript_unavailable");
}

function decodeFragment(value: unknown): VoiceCallTranscriptFragment {
  if (!value || typeof value !== "object") throw unavailable();
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || typeof row.event_id !== "string" || !row.event_id ||
    (row.role !== "customer" && row.role !== "assistant") || typeof row.content !== "string" ||
    row.content.length > 16000 || typeof row.start_ms !== "number" || typeof row.end_ms !== "number" ||
    !Number.isFinite(row.start_ms) || !Number.isFinite(row.end_ms) || row.start_ms < 0 || row.end_ms < row.start_ms) throw unavailable();
  return { id: row.id, eventId: row.event_id, role: row.role, text: row.content, startMs: row.start_ms, endMs: row.end_ms };
}
