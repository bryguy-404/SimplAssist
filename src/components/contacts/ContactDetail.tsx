"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  X,
  Phone,
  MessageCircle,
  Flame,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { createBrowserClient } from "@/lib/supabase/client";
import { formatPhoneNumber, formatDate } from "@/lib/utils";
import type { Contact, Conversation } from "@/types/database";
import {
  inputField,
  ink,
  body,
  statusSuccess,
  statusWarning,
  statusNeutral,
} from "@/lib/theme-v2/theme";

interface ContactDetailProps {
  contact: Contact;
  conversations: Conversation[];
  onClose: () => void;
  onUpdated: (contact: Contact) => void;
  onDeleted: (contactId: string) => void;
}

type LeadStatus = Contact["lead_status"];

const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  normal: "Normal",
  warm: "Warm",
  hot: "Hot",
};

function relativeTime(date: string): string {
  const now = new Date();
  const d = new Date(date);
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return formatDate(date, "PP");
}

function LeadBadge({ status }: { status: LeadStatus }) {
  let color = statusNeutral;
  if (status === "hot") {
    color = statusSuccess;
  } else if (status === "warm") {
    color = statusWarning;
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {status === "hot" && <Flame className="h-3 w-3" />}
      {LEAD_STATUS_LABEL[status]}
    </span>
  );
}

export default function ContactDetail({
  contact,
  conversations,
  onClose,
  onUpdated,
  onDeleted,
}: ContactDetailProps) {
  const router = useRouter();
  const supabase = createBrowserClient();

  const [name, setName] = useState(contact.name ?? "");
  const [editingName, setEditingName] = useState(false);
  const [phone, setPhone] = useState(contact.phone_number ?? "");
  const [editingPhone, setEditingPhone] = useState(false);
  const [email, setEmail] = useState(contact.email ?? "");
  const [editingEmail, setEditingEmail] = useState(false);
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const hasVoiceHistory = conversations.some((conversation) => conversation.channel === "voice");

  async function saveName() {
    setEditingName(false);
    const trimmed = name.trim() || null;
    if (trimmed === contact.name) return;
    setSaving(true);
    const { data } = await supabase
      .from("contacts")
      .update({ name: trimmed })
      .eq("id", contact.id)
      .select()
      .single();
    setSaving(false);
    if (data) onUpdated(data as Contact);
  }

  async function savePhone() {
    setEditingPhone(false);
    const trimmed = phone.trim() || null;
    if (trimmed === contact.phone_number) return;
    setSaving(true);
    const { data } = await supabase
      .from("contacts")
      .update({ phone_number: trimmed })
      .eq("id", contact.id)
      .select()
      .single();
    setSaving(false);
    if (data) onUpdated(data as Contact);
  }

  async function saveEmail() {
    setEditingEmail(false);
    const trimmed = email.trim() || null;
    if (trimmed === contact.email) return;
    setSaving(true);
    const { data } = await supabase
      .from("contacts")
      .update({ email: trimmed })
      .eq("id", contact.id)
      .select()
      .single();
    setSaving(false);
    if (data) onUpdated(data as Contact);
  }

  async function saveNotes() {
    const trimmed = notes.trim() || null;
    if (trimmed === contact.notes) return;
    setSaving(true);
    const { data } = await supabase
      .from("contacts")
      .update({ notes: trimmed })
      .eq("id", contact.id)
      .select()
      .single();
    setSaving(false);
    if (data) onUpdated(data as Contact);
  }

  async function deleteContact() {
    if (hasVoiceHistory || saving) return;
    setSaving(true);
    setDeleteError(null);
    try {
      const { data, error } = await supabase.from("contacts").delete().eq("id", contact.id).select("id");
      if (error || !data?.some((row: { id: string }) => row.id === contact.id)) {
        setDeleteError("The contact could not be deleted. Please refresh and try again.");
        return;
      }
      onDeleted(contact.id);
    } catch {
      setDeleteError("The contact could not be deleted. Please refresh and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20 dark:bg-black/50" onClick={onClose} />
      <div className="relative z-10 flex w-full max-w-full sm:max-w-lg flex-col overflow-y-auto bg-white dark:bg-[rgba(18,18,20,0.95)] dark:backdrop-blur-[20px] shadow-xl dark:shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#ece4d8] dark:border-white/[0.10] px-6 py-4">
          <h2 className={`text-lg font-semibold ${ink}`}>
            Contact Details
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-stone-500 dark:text-[#666] hover:bg-[#faf6ef] dark:hover:bg-white/[0.04] hover:text-stone-700 dark:hover:text-[#bdbdbf]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-6 p-6">
          {/* Name */}
          <div>
            <label className="text-xs font-medium uppercase text-stone-500 dark:text-[#bdbdbf]">
              Name
            </label>
            {editingName ? (
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => e.key === "Enter" && saveName()}
                className={`mt-1 ${inputField}`}
              />
            ) : (
              <p
                onClick={() => setEditingName(true)}
                className={`mt-1 cursor-pointer rounded-lg px-3 py-2 text-sm hover:bg-[#faf6ef] dark:hover:bg-white/[0.04] ${ink}`}
              >
                {contact.name || "Unknown"}{" "}
                <span className="text-xs text-stone-400 dark:text-[#666]">(click to edit)</span>
              </p>
            )}
          </div>

          {/* Phone */}
          <div>
            <label className="text-xs font-medium uppercase text-stone-500 dark:text-[#bdbdbf]">
              Phone
            </label>
            {editingPhone ? (
              <input
                autoFocus
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onBlur={savePhone}
                onKeyDown={(e) => e.key === "Enter" && savePhone()}
                placeholder="Enter phone number"
                className={`mt-1 ${inputField}`}
              />
            ) : (
              <p
                onClick={() => setEditingPhone(true)}
                className={`mt-1 cursor-pointer rounded-lg px-3 py-2 text-sm hover:bg-[#faf6ef] dark:hover:bg-white/[0.04] ${ink}`}
              >
                {contact.phone_number ? formatPhoneNumber(contact.phone_number) : "—"}{" "}
                <span className="text-xs text-stone-400 dark:text-[#666]">(click to edit)</span>
              </p>
            )}
          </div>

          {/* Email */}
          <div>
            <label className="text-xs font-medium uppercase text-stone-500 dark:text-[#bdbdbf]">
              Email
            </label>
            {editingEmail ? (
              <input
                autoFocus
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={saveEmail}
                onKeyDown={(e) => e.key === "Enter" && saveEmail()}
                placeholder="Enter email address"
                className={`mt-1 ${inputField}`}
              />
            ) : (
              <p
                onClick={() => setEditingEmail(true)}
                className={`mt-1 cursor-pointer rounded-lg px-3 py-2 text-sm hover:bg-[#faf6ef] dark:hover:bg-white/[0.04] ${ink}`}
              >
                {contact.email || "—"}{" "}
                <span className="text-xs text-stone-400 dark:text-[#666]">(click to edit)</span>
              </p>
            )}
          </div>

          {/* Channel & Lead status */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
            <div>
              <label className="text-xs font-medium uppercase text-stone-500 dark:text-[#bdbdbf]">
                Channel
              </label>
              <p className={`mt-1 flex items-center gap-1.5 text-sm ${ink}`}>
                {contact.source_channel === "voice" ? (
                  <Phone aria-label="AI voice call" className="h-4 w-4" />
                ) : contact.source_channel === "sms" ? (
                  <Phone className="h-4 w-4 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" />
                ) : (
                  <MessageCircle className="h-4 w-4 text-stone-500 dark:text-[#bdbdbf]" />
                )}
                {contact.source_channel === "voice" ? "AI voice call" : contact.source_channel === "sms" ? "SMS" : "Web Chat"}
              </p>
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-stone-500 dark:text-[#bdbdbf]">
                Lead status
              </label>
              <div className="mt-1">
                <LeadBadge status={contact.lead_status} />
              </div>
            </div>
          </div>

          {/* Dates */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
            <div>
              <label className="text-xs font-medium uppercase text-stone-500 dark:text-[#bdbdbf]">
                Created
              </label>
              <p className={`mt-1 text-sm ${body}`}>
                {formatDate(contact.created_at, "PP")}
              </p>
            </div>
            <div>
              <label className="text-xs font-medium uppercase text-stone-500 dark:text-[#bdbdbf]">
                Last Contacted
              </label>
              <p className={`mt-1 text-sm ${body}`}>
                {relativeTime(contact.last_contacted_at)}
              </p>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-medium uppercase text-stone-500 dark:text-[#bdbdbf]">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={saveNotes}
              placeholder="Add notes about this contact..."
              rows={3}
              className={`mt-1 ${inputField}`}
            />
          </div>

          {/* Conversations */}
          <div>
            <label className="text-xs font-medium uppercase text-stone-500 dark:text-[#bdbdbf]">
              Conversations ({conversations.length})
            </label>
            {conversations.length === 0 ? (
              <p className="mt-2 text-sm text-stone-400 dark:text-[#666]">No conversations yet</p>
            ) : (
              <div className="mt-2 space-y-2">
                {conversations.map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() =>
                      router.push(`/conversations?conversation=${conv.id}`)
                    }
                    className="flex w-full items-center justify-between rounded-lg border border-[#ece4d8] dark:border-white/[0.10] px-4 py-3 text-left transition hover:border-[rgb(var(--brand-primary-rgb)/.40)] dark:hover:border-[rgb(var(--brand-primary-dark-rgb)/.40)] hover:bg-[var(--brand-accent-soft)] dark:hover:bg-[rgb(var(--brand-primary-dark-rgb)/.08)]"
                  >
                    <div className="flex items-center gap-3">
                      {conv.channel === "sms" || conv.channel === "voice" ? (
                        <Phone className="h-4 w-4 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" />
                      ) : (
                        <MessageCircle className="h-4 w-4 text-stone-500 dark:text-[#bdbdbf]" />
                      )}
                      <div>
                        <p className={`text-sm font-medium ${ink}`}>
                          {conv.channel === "voice" ? "AI voice call" : conv.channel === "sms" ? "SMS" : "Web Chat"}
                        </p>
                        <p className={`text-xs ${body}`}>
                          {relativeTime(conv.last_message_at)}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          conv.status === "active"
                            ? statusSuccess
                            : conv.status === "handed_off"
                            ? statusWarning
                            : statusNeutral
                        }`}
                      >
                        {conv.status}
                      </span>
                      <ExternalLink className="h-3.5 w-3.5 text-stone-400 dark:text-[#666]" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Delete */}
          <div className="border-t border-[#ece4d8] dark:border-white/[0.10] pt-4">
            {hasVoiceHistory ? (
              <p className={`text-sm ${body}`}>Contacts with voice call history cannot be deleted here.</p>
            ) : confirmDelete ? (
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <p className="text-sm text-red-600 dark:text-red-400">
                  Delete this contact and all their data?
                </p>
                <button
                  onClick={deleteContact}
                  disabled={saving}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg border border-[#e7e0d4] dark:border-white/[0.10] px-3 py-1.5 text-sm font-medium text-stone-700 dark:text-[#bdbdbf] hover:bg-[#faf6ef] dark:hover:bg-white/[0.04]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
              >
                <Trash2 className="h-4 w-4" />
                Delete Contact
              </button>
            )}
            {deleteError ? <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{deleteError}</p> : null}
          </div>

          {saving && (
            <p className="text-xs text-stone-400 dark:text-[#666]">Saving...</p>
          )}
        </div>
      </div>
    </div>
  );
}
