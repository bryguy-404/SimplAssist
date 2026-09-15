"use client";

import { Users, UserPlus, Flame, Phone, MessageCircle } from "lucide-react";
import type { Contact } from "@/types/database";
import { orangeAccentIcon } from "@/lib/glass";
import { card, ink, body } from "@/lib/theme-v2/theme";

interface ContactStatsProps {
  contacts: Contact[];
}

export default function ContactStats({ contacts }: ContactStatsProps) {
  const total = contacts.length;

  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
  const newThisWeek = contacts.filter(
    (c) => new Date(c.created_at) >= oneWeekAgo
  ).length;

  const hotLeads = contacts.filter((c) => c.lead_status === "hot").length;

  const smsCount = contacts.filter((c) => c.source_channel === "sms").length;
  const voiceCount = contacts.filter(c => c.source_channel === "voice").length;
  const webChatCount = contacts.filter(
    (c) => c.source_channel === "web_chat"
  ).length;

  const stats = [
    {
      label: "Total Contacts",
      value: total,
      icon: Users,
      color: "text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]",
    },
    {
      label: "New This Week",
      value: newThisWeek,
      icon: UserPlus,
      color: "text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]",
    },
    {
      label: "Hot Leads",
      value: hotLeads,
      icon: Flame,
      color: "text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]",
    },
    {
      label: voiceCount > 0 ? "SMS / Web Chat / Voice" : "SMS / Web Chat",
      value: `${smsCount} / ${webChatCount}` + (voiceCount > 0 ? ` / ${voiceCount}` : ""),
      icon: Phone,
      secondIcon: MessageCircle,
      color: "text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className={`p-5 ${card}`}
        >
          <div className="flex items-center gap-3">
            <div className={`p-2.5 ${orangeAccentIcon}`}>
              <stat.icon className={`h-5 w-5 ${stat.color}`} />
            </div>
            <div>
              <p className={`text-sm ${body}`}>{stat.label}</p>
              <p className={`text-2xl font-semibold ${ink}`}>
                {stat.value}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
