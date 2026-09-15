"use client";

import { useState, useMemo, useEffect } from "react";
import {
  Search,
  Phone,
  MessageCircle,
  Flame,
  ArrowUpDown,
} from "lucide-react";
import { formatPhoneNumber } from "@/lib/utils";
import type { Contact, Conversation } from "@/types/database";
import ContactDetail from "./ContactDetail";
import {
  card,
  ink,
  body,
  statusSuccess,
  statusWarning,
  statusNeutral,
} from "@/lib/theme-v2/theme";

type Filter = "all" | "sms" | "web_chat" | "hot";
type Sort = "recent" | "status" | "name";
type LeadStatus = Contact["lead_status"];

const LEAD_STATUS_RANK: Record<LeadStatus, number> = {
  normal: 0,
  warm: 1,
  hot: 2,
};

const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  normal: "Normal",
  warm: "Warm",
  hot: "Hot",
};

interface ContactWithCount extends Contact {
  conversation_count: number;
}

interface ContactsTableProps {
  contacts: ContactWithCount[];
  conversations: Conversation[];
}

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
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths}mo ago`;
}

function LeadBadge({ status }: { status: LeadStatus }) {
  let color = statusNeutral;
  if (status === "hot") {
    color = statusSuccess;
  } else if (status === "warm") {
    color = statusWarning;
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {status === "hot" && <Flame className="h-3 w-3" />}
      {LEAD_STATUS_LABEL[status]}
    </span>
  );
}

export default function ContactsTable({
  contacts: initialContacts,
  conversations: allConversations,
}: ContactsTableProps) {
  const [contacts, setContacts] = useState(initialContacts);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [selectedContact, setSelectedContact] = useState<ContactWithCount | null>(null);

  // Keep contacts in sync when props change
  useEffect(() => {
    setContacts(initialContacts);
  }, [initialContacts]);

  const filtered = useMemo(() => {
    let result = contacts;

    // Search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.phone_number && c.phone_number.includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q))
      );
    }

    // Filter
    if (filter === "sms") result = result.filter((c) => c.source_channel === "sms");
    if (filter === "web_chat") result = result.filter((c) => c.source_channel === "web_chat");
    if (filter === "hot") result = result.filter((c) => c.lead_status === "hot");

    // Sort
    result = [...result].sort((a, b) => {
      if (sort === "recent")
        return new Date(b.last_contacted_at).getTime() - new Date(a.last_contacted_at).getTime();
      if (sort === "status") {
        const rankDifference =
          LEAD_STATUS_RANK[b.lead_status] - LEAD_STATUS_RANK[a.lead_status];
        if (rankDifference !== 0) return rankDifference;

        const updatedAtDifference =
          new Date(b.lead_status_updated_at).getTime() -
          new Date(a.lead_status_updated_at).getTime();
        if (updatedAtDifference !== 0) return updatedAtDifference;
      }
      return (a.name ?? "").localeCompare(b.name ?? "");
    });

    return result;
  }, [contacts, search, filter, sort]);

  const selectedConversations = useMemo(
    () =>
      selectedContact
        ? allConversations.filter((c) => c.contact_id === selectedContact.id)
        : [],
    [selectedContact, allConversations]
  );

  function handleUpdated(updated: Contact) {
    setContacts((prev) =>
      prev.map((c) =>
        c.id === updated.id
          ? { ...updated, conversation_count: c.conversation_count }
          : c
      )
    );
    setSelectedContact((prev) =>
      prev && prev.id === updated.id
        ? { ...updated, conversation_count: prev.conversation_count }
        : prev
    );
  }

  function handleDeleted(id: string) {
    setContacts((prev) => prev.filter((c) => c.id !== id));
    setSelectedContact(null);
  }

  const filters: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "sms", label: "SMS" },
    { key: "web_chat", label: "Web Chat" },
    { key: "hot", label: "Hot Leads" },
  ];

  const sorts: { key: Sort; label: string }[] = [
    { key: "recent", label: "Most Recent" },
    { key: "status", label: "Lead status" },
    { key: "name", label: "Name A-Z" },
  ];

  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Search */}
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400 dark:text-[#666]" />
          <input
            type="text"
            placeholder="Search contacts..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-[22px] py-2 pl-9 pr-3 text-sm bg-white text-stone-900 placeholder:text-stone-400 border border-[#e3dacc] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:placeholder:text-[#666] dark:border-white/[0.12] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] transition-[border-color,box-shadow] duration-150"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Filters */}
          <div className="flex rounded-[22px] border border-[#ece4d8] dark:border-white/[0.10] bg-[#faf7f2] dark:bg-transparent dark:bg-[linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.03))] overflow-hidden">
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-3 py-1.5 text-xs font-medium transition ${
                  filter === f.key
                    ? "bg-[var(--brand-primary)] text-white dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b]"
                    : "text-stone-600 dark:text-[#bdbdbf] hover:bg-[#faf6ef] dark:hover:bg-white/[0.06]"
                } ${f.key === "all" ? "rounded-l-[22px]" : ""} ${
                  f.key === "hot" ? "rounded-r-[22px]" : ""
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Sort */}
          <div className="relative">
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="appearance-none rounded-[22px] py-1.5 pl-3 pr-8 text-xs font-medium bg-white text-stone-900 border border-[#e3dacc] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:border-white/[0.12] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] transition-[border-color,box-shadow] duration-150"
            >
              {sorts.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <ArrowUpDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400 dark:text-[#666]" />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className={`mt-4 overflow-hidden ${card}`}>
        {filtered.length === 0 ? (
          <div className={`px-6 py-12 text-center text-sm ${body}`}>
            No contacts found
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className={`border-b border-[#ece4d8] dark:border-white/[0.06] bg-[#faf7f2] dark:bg-white/[0.03] text-left text-xs font-medium uppercase tracking-wider ${body}`}>
                <th className="px-6 py-3">Name</th>
                <th className="px-6 py-3 hidden sm:table-cell">Phone</th>
                <th className="px-6 py-3 hidden md:table-cell">Email</th>
                <th className="px-6 py-3">Channel</th>
                <th className="px-6 py-3">Lead status</th>
                <th className="px-6 py-3 hidden lg:table-cell">Conversations</th>
                <th className="px-6 py-3 hidden lg:table-cell">Last Contact</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#ece4d8] dark:divide-white/[0.06]">
              {filtered.map((contact) => (
                <tr
                  key={contact.id}
                  onClick={() => setSelectedContact(contact)}
                  className="cursor-pointer transition hover:bg-[#faf6ef] dark:hover:bg-white/[0.04]"
                >
                  <td className={`px-6 py-4 text-sm font-medium ${ink}`}>
                    {contact.name || "Unknown"}
                  </td>
                  <td className={`hidden px-6 py-4 text-sm sm:table-cell ${body}`}>
                    {contact.phone_number
                      ? formatPhoneNumber(contact.phone_number)
                      : "\u2014"}
                  </td>
                  <td className={`hidden px-6 py-4 text-sm md:table-cell ${body}`}>
                    {contact.email || "\u2014"}
                  </td>
                  <td className="px-6 py-4">
                    {contact.source_channel === "voice" ? (
                  <Phone aria-label="Voice call" className="h-4 w-4" />
                ) : contact.source_channel === "sms" ? (
                      <Phone className="h-4 w-4 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" />
                    ) : (
                      <MessageCircle className="h-4 w-4 text-stone-500 dark:text-[#bdbdbf]" />
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <LeadBadge status={contact.lead_status} />
                  </td>
                  <td className={`hidden px-6 py-4 text-sm lg:table-cell ${body}`}>
                    {contact.conversation_count}
                  </td>
                  <td className={`hidden px-6 py-4 text-sm lg:table-cell ${body}`}>
                    {relativeTime(contact.last_contacted_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Detail Panel */}
      {selectedContact && (
        <ContactDetail
          contact={selectedContact}
          conversations={selectedConversations}
          onClose={() => setSelectedContact(null)}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
        />
      )}
    </>
  );
}
