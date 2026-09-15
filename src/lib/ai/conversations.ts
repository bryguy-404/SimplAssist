import { supabaseAdmin } from "@/lib/supabase/admin";
import { buildWidgetSourceProviderEventId } from "@/lib/widget/idempotency.server";
import type { Conversation, Message, Channel, MessageRole } from "@/types/database";

export class WebChatMessageIdempotencyConflictError extends Error {
  constructor() {
    super("web_chat_message_idempotency_conflict");
    this.name = "WebChatMessageIdempotencyConflictError";
  }
}

export async function getOrCreateConversation(
  businessId: string,
  contactId: string,
  channel: Channel,
  options: { defaultAiHandling?: boolean } = {}
): Promise<Conversation> {
  // A handed-off conversation is still the live customer thread. Reusing it
  // is essential: creating a fresh `active` row would silently turn AI back
  // on after a human agent took over.
  if (channel === "voice") throw new Error("Voice conversations are created once per admitted call.");
  const existing = await findOpenConversation(businessId, contactId, channel);

  if (existing) return existing as Conversation;

  const isAiHandling = options.defaultAiHandling ?? true;

  const { data, error } = await supabaseAdmin
    .from("conversations")
    .insert({
      business_id: businessId,
      contact_id: contactId,
      channel,
      status: isAiHandling ? "active" : "handed_off",
      is_ai_handling: isAiHandling,
      started_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    // The open-thread unique index can reject this insert when another inbound
    // request wins the find-or-create race. Re-read the winner, preserving a
    // handed-off/manual row if human takeover occurred during that window.
    if (error.code === "23505") {
      const canonical = await findOpenConversation(
        businessId,
        contactId,
        channel
      );
      if (canonical) return canonical;
    }
    throw error;
  }
  if (!data) throw new Error("Conversation insert returned no row.");
  return data as Conversation;
}

async function findOpenConversation(
  businessId: string,
  contactId: string,
  channel: Channel
): Promise<Conversation | null> {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("*")
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .neq("status", "closed")
    // False means a human has control even if a stale status value remains.
    // The secondary status sort also puts handed_off ahead of active.
    .order("is_ai_handling", { ascending: true })
    .order("status", { ascending: false })
    .order("last_message_at", { ascending: false })
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data as Conversation | null) ?? null;
}

export async function addMessage(
  conversationId: string,
  businessId: string,
  role: MessageRole,
  content: string,
  channel: Channel,
  options: {
    aiReplyReservationId: string;
    aiReplyReservationAttemptToken: string;
  } | null = null,
): Promise<Message> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: conversationId,
      business_id: businessId,
      role,
      content,
      channel,
      ...(options
        ? {
            ai_reply_reservation_id: options.aiReplyReservationId,
            ai_reply_reservation_attempt_token:
              options.aiReplyReservationAttemptToken,
          }
        : {}),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw error ?? new Error("Message insert returned no row.");
  }

  await touchConversation(
    conversationId,
    businessId,
    new Date().toISOString()
  );

  return data as Message;
}

/**
 * Persist one browser-originated customer message exactly once. The opaque
 * provider-event key contains no session, email, name, or message content.
 * A reused client id with different immutable content fails closed.
 */
export async function addWebChatInboundMessageOnce(
  conversationId: string,
  businessId: string,
  content: string,
  clientMessageId: string,
): Promise<Message> {
  const providerEventId = buildWidgetSourceProviderEventId({
    businessId,
    clientMessageId,
  });

  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: conversationId,
      business_id: businessId,
      role: "customer",
      content,
      channel: "web_chat",
      provider_event_id: providerEventId,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code !== "23505") throw error;

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("messages")
      .select("*")
      .eq("provider_event_id", providerEventId)
      .maybeSingle();

    if (existingError) throw existingError;
    if (
      !existing ||
      existing.business_id !== businessId ||
      existing.role !== "customer" ||
      existing.channel !== "web_chat" ||
      existing.content !== content
    ) {
      throw new WebChatMessageIdempotencyConflictError();
    }
    await touchConversation(
      existing.conversation_id,
      businessId,
      typeof existing.created_at === "string"
        ? existing.created_at
        : new Date().toISOString(),
    );
    return existing as Message;
  }

  if (!data) throw new Error("Web chat message insert returned no row.");
  await touchConversation(
    conversationId,
    businessId,
    typeof data.created_at === "string"
      ? data.created_at
      : new Date().toISOString(),
  );
  return data as Message;
}

export async function getConversationById(
  conversationId: string,
): Promise<Conversation> {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Conversation ${conversationId} was not found.`);
  return data as Conversation;
}

/**
 * Persist a provider-originated customer message exactly once. The database
 * migration enforces a unique partial index on provider_event_id; a retry
 * returns the already-written row instead of duplicating the transcript.
 */
export async function addInboundMessageOnce(
  conversationId: string,
  businessId: string,
  content: string,
  channel: Channel,
  providerEventId: string
): Promise<Message> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: conversationId,
      business_id: businessId,
      role: "customer",
      content,
      channel,
      provider_event_id: providerEventId,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code !== "23505") throw error;

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("messages")
      .select("*")
      .eq("provider_event_id", providerEventId)
      .maybeSingle();

    if (existingError) throw existingError;
    if (
      !existing ||
      existing.business_id !== businessId ||
      existing.conversation_id !== conversationId ||
      existing.role !== "customer"
    ) {
      throw new Error(
        `Provider event ${providerEventId} collided with a different message.`
      );
    }
    await touchConversation(
      conversationId,
      businessId,
      typeof existing.created_at === "string"
        ? existing.created_at
        : new Date().toISOString()
    );
    return existing as Message;
  }

  if (!data) throw new Error("Inbound message insert returned no row.");
  await touchConversation(
    conversationId,
    businessId,
    typeof data.created_at === "string"
      ? data.created_at
      : new Date().toISOString()
  );
  return data as Message;
}

async function touchConversation(
  conversationId: string,
  businessId: string,
  lastMessageAt: string
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("conversations")
    .update({ last_message_at: lastMessageAt })
    .eq("id", conversationId)
    .eq("business_id", businessId)
    // A delayed provider retry must never move an inbox thread behind a newer
    // message. Postgres re-evaluates this predicate after row locking, making
    // concurrent touches monotonic without a read-then-write race.
    .or(
      `last_message_at.is.null,last_message_at.lt.${lastMessageAt}`
    );
  if (error) throw error;
}

export async function getConversationAiState(
  conversationId: string
): Promise<Pick<Conversation, "id" | "status" | "is_ai_handling">> {
  const { data, error } = await supabaseAdmin
    .from("conversations")
    .select("id, status, is_ai_handling")
    .eq("id", conversationId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error(`Conversation ${conversationId} was not found.`);
  return data as Pick<Conversation, "id" | "status" | "is_ai_handling">;
}

export function isAiHandlingActive(
  conversation: Pick<Conversation, "status" | "is_ai_handling">
): boolean {
  return conversation.status === "active" && conversation.is_ai_handling === true;
}

export async function getConversationHistory(
  conversationId: string,
  limit: number = 20
): Promise<Message[]> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    // Fetch the newest window, not the oldest window. The AI must always see
    // the inbound message that just triggered it once a thread exceeds the
    // history limit. A second key makes equal timestamps deterministic.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ([...(data ?? [])] as Message[]).reverse();
}

export async function closeConversation(
  conversationId: string
): Promise<void> {
  await supabaseAdmin
    .from("conversations")
    .update({ status: "closed" })
    .eq("id", conversationId);
}
