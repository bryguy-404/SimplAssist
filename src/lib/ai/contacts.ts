import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Contact, Channel } from "@/types/database";

export async function findOrCreateContact(
  businessId: string,
  phone: string | null,
  email: string | null,
  channel: Channel,
  sessionId: string | null = null
): Promise<Contact> {
  const existing = await findExistingContact(
    businessId,
    phone,
    email,
    channel,
    sessionId
  );

  if (existing) {
    return touchExistingContact(existing, email);
  }

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .insert({
      business_id: businessId,
      phone_number: phone,
      email: email,
      session_id: sessionId,
      source_channel: channel,
      lead_score: 0,
      last_contacted_at: new Date().toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    // A concurrent request may have inserted the same phone/session after our
    // lookup but before this insert. The unique identity indexes make one row
    // authoritative; recover by returning that winner instead of turning a
    // valid inbound message into a transient failure.
    if (error.code === "23505") {
      const canonical = await findExistingContact(
        businessId,
        phone,
        email,
        channel,
        sessionId
      );
      if (canonical) return touchExistingContact(canonical, email);
    }
    throw error;
  }
  if (!data) throw new Error("Contact insert returned no row.");
  return data as Contact;
}

/**
 * Find the canonical contact using provider-stable identities first.
 *
 * A widget session identifies the live visitor thread more reliably than an
 * optional/re-entered email address, so web chat always checks session before
 * falling back to email. SMS callers are keyed by their phone number.
 */
async function findExistingContact(
  businessId: string,
  phone: string | null,
  email: string | null,
  channel: Channel,
  sessionId: string | null
): Promise<Contact | null> {
  if ((channel === "sms" || channel === "voice") && phone) {
    return queryContactByIdentity(businessId, "phone_number", phone);
  }

  if (channel === "web_chat" && sessionId) {
    const bySession = await queryContactByIdentity(
      businessId,
      "session_id",
      sessionId
    );
    if (bySession) return bySession;
  }

  if (channel === "web_chat" && email) {
    return queryContactByIdentity(businessId, "email", email);
  }

  return null;
}

async function queryContactByIdentity(
  businessId: string,
  column: "phone_number" | "session_id" | "email",
  value: string
): Promise<Contact | null> {
  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("*")
    .eq("business_id", businessId)
    .eq(column, value)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Contact | null) ?? null;
}

async function touchExistingContact(
  existing: Contact,
  email: string | null
): Promise<Contact> {
  const updateFields: Record<string, unknown> = {
    last_contacted_at: new Date().toISOString(),
  };
  if (email && !existing.email) {
    updateFields.email = email;
  }
  const { data, error } = await supabaseAdmin
    .from("contacts")
    .update(updateFields)
    .eq("id", existing.id)
    .select("*")
    .single();
  if (error || !data) {
    throw error ?? new Error(`Contact ${existing.id} disappeared during update.`);
  }
  return data as Contact;
}

export async function updateContactName(
  contactId: string,
  name: string
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("contacts")
    .update({ name })
    .eq("id", contactId);
  if (error) throw error;
}

export async function updateContactEmail(
  contactId: string,
  email: string
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("contacts")
    .update({ email })
    .eq("id", contactId);
  if (error) throw error;
}

export async function incrementLeadScore(
  contactId: string,
  amount: number
): Promise<void> {
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("lead_score")
    .eq("id", contactId)
    .single();

  const currentScore = data?.lead_score ?? 0;

  await supabaseAdmin
    .from("contacts")
    .update({ lead_score: currentScore + amount })
    .eq("id", contactId);
}
