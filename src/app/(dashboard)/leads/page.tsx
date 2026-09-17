import Link from "next/link";
import { redirect } from "next/navigation";
import { getDashboardBusinessContext } from "@/lib/dashboard/context";
import { requireWorkspacePageAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { businessWallTimeToInstant } from "@/lib/google/calendarTime";
import { body, card, ink } from "@/lib/theme-v2/theme";
import { formatPhoneNumber } from "@/lib/utils";
import { loadVoiceLeadReviews, type VoiceLeadReview } from "@/lib/voice/leadReview.server";

const LEAD_EVENT_LIST_LIMIT = 200;

const LEAD_EVENT_SELECT = `
  id,
  occurred_at,
  event_type,
  conversation_id,
  contact_id,
  origin_kind,
  voice_action_id,
  source_conversation_id,
  contact:contacts!goal_events_contact_id_fkey (
    name,
    phone_number,
    email
  )
`;

interface LeadEventContact {
  name: string | null;
  phone_number: string | null;
  email: string | null;
}

interface LeadEventRow {
  id: string;
  occurred_at: string;
  event_type: string;
  conversation_id: string | null;
  contact_id: string | null;
  origin_kind: "conversation" | "voice_action";
  voice_action_id: string | null;
  source_conversation_id: string | null;
  contact: LeadEventContact | null;
}

interface MonthRange {
  start: string;
  end: string;
  timeZone: string;
}

export default async function LeadsPage({ searchParams }: { searchParams?: { lead?: string | string[] } } = {}) {
  await requireWorkspacePageAccess();
  const context = await getDashboardBusinessContext();
  if (context.status === "unauthenticated") redirect("/login");
  if (context.status !== "resolved") redirect("/onboarding");

  const { supabase, business } = context;
  if (business.primary_goal !== "signup") redirect("/dashboard");

  const month = currentBusinessMonth(new Date(), business.timezone);
  const listQuery = supabase
    .from("goal_events")
    .select(LEAD_EVENT_SELECT)
    .eq("business_id", business.id)
    .eq("goal_at_event", "signup")
    .eq("event_type", "link_sent")
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(LEAD_EVENT_LIST_LIMIT);
  const countQuery = supabase
    .from("goal_events")
    .select("id", { count: "exact", head: true })
    .eq("business_id", business.id)
    .eq("goal_at_event", "signup")
    .eq("event_type", "link_sent")
    .gte("occurred_at", month.start)
    .lt("occurred_at", month.end);

  const [listResult, countResult] = await Promise.all([
    listQuery,
    countQuery,
  ]);
  const listError = listResult.error;
  const countError = countResult.error;
  const events = (listResult.data ?? []) as unknown as LeadEventRow[];
  const selectedLeadId = typeof searchParams?.lead === "string" ? searchParams.lead : null;
  if (!listError && selectedLeadId && !events.some((event) => event.id === selectedLeadId)) {
    const selected = await supabase.from("goal_events").select(LEAD_EVENT_SELECT)
      .eq("business_id", business.id).eq("goal_at_event", "signup").eq("event_type", "link_sent")
      .eq("id", selectedLeadId).maybeSingle();
    if (!selected.error && selected.data) events.unshift(selected.data as unknown as LeadEventRow);
  }
  let voiceReviews = new Map<string, VoiceLeadReview>();
  let voiceReviewUnavailable = false;
  if (!listError) {
    try { voiceReviews = await loadVoiceLeadReviews(supabase, business.id, events); }
    catch { voiceReviewUnavailable = true; }
  }
  const monthlyCount =
    !countError && typeof countResult.count === "number"
      ? countResult.count
      : null;

  if (listError) {
    console.error(
      `[leads:page] Could not load goal events for business=${business.id}:`,
      listError
    );
  }
  if (countError) {
    console.error(
      `[leads:page] Could not count current-month goal events for business=${business.id}:`,
      countError
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className={`text-2xl font-bold ${ink}`}>Leads</h1>
        <p className={`mt-1 text-sm ${body}`}>
          See each signup link your assistant sent. A sent or delivered link does not confirm a completed signup.
        </p>
      </header>

      <section
        className={`${card} w-full p-5 sm:max-w-xs`}
        aria-label="Monthly signup link activity"
      >
        <p className={`text-sm font-medium ${body}`}>Signup links sent</p>
        <p className={`mt-2 text-3xl font-bold ${ink}`}>
          {monthlyCount ?? "\u2014"}
        </p>
        <p className={`mt-1 text-xs ${body}`}>This month</p>
      </section>

      <section aria-labelledby="lead-events-heading">
        <h2 id="lead-events-heading" className="sr-only">
          Signup link history
        </h2>
        <div className={`overflow-hidden ${card}`}>
          {listError ? (
            <div className={`px-6 py-12 text-center text-sm ${body}`}>
              Leads could not be loaded.
            </div>
          ) : events.length === 0 ? (
            <div className={`px-6 py-12 text-center text-sm ${body}`}>
              No signup links sent yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px]">
                <thead>
                  <tr
                    className={`border-b border-[#ece4d8] bg-[#faf7f2] text-left text-xs font-medium uppercase tracking-wider dark:border-white/[0.06] dark:bg-white/[0.03] ${body}`}
                  >
                    <th className="px-6 py-3">Date &amp; time</th>
                    <th className="px-6 py-3">Contact</th>
                    <th className="px-6 py-3">Event</th>
                    <th className="px-6 py-3">Source &amp; conversations</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ece4d8] dark:divide-white/[0.06]">
                  {events.map((event) => {
                    const voiceReview = voiceReviews.get(event.id);
                    const confirmed = voiceReview?.confirmedContact;
                    const occurredAt = formatOccurredAt(
                      event.occurred_at,
                      month.timeZone
                    );
                    return (
                      <tr
                        key={event.id}
                        id={`lead-${event.id}`}
                        className="scroll-mt-6 transition hover:bg-[#faf6ef] target:bg-[#faf6ef] dark:hover:bg-white/[0.04] dark:target:bg-white/[0.04]"
                      >
                        <td className={`px-6 py-4 text-sm ${body}`}>
                          <time dateTime={event.occurred_at}>
                            <span className="block font-medium">{occurredAt.date}</span>
                            <span className="block text-xs">{occurredAt.time}</span>
                          </time>
                        </td>
                        <td className={`px-6 py-4 text-sm font-medium ${ink}`}>
                          <p>{confirmed?.name || contactDisplay(event.contact)}</p>
                          {confirmed ? <>
                            <p className={`mt-1 text-xs font-normal ${body}`}>Confirmed during the call</p>
                            <p className="mt-1 text-xs font-normal">{formatPhoneNumber(confirmed.phone)}</p>
                            <p className="mt-1 break-all text-xs font-normal">{confirmed.email || "No email confirmed"}</p>
                            {confirmed.conflicts.length ? <p className={`mt-2 text-xs font-normal ${body}`}>Stored contact differs: {event.contact?.name || "Name not set"}{event.contact?.email ? ` · ${event.contact.email}` : ""}. Existing details were kept.</p> : null}
                          </> : event.origin_kind === "voice_action" ? <p className={`mt-1 text-xs font-normal ${body}`}>Stored contact · {voiceReviewUnavailable ? "Call details temporarily unavailable" : "No confirmed call details available"}</p> : null}
                          {event.contact_id ? <Link href={`/contacts?contact=${encodeURIComponent(event.contact_id)}`} className="mt-2 inline-flex text-xs font-medium text-[var(--brand-accent)] underline dark:text-[var(--brand-accent-dark)]">View contact</Link> : null}
                        </td>
                        <td className={`px-6 py-4 text-sm ${body}`}>
                          <p>{voiceReview?.status.label || "Signup link sent"}</p>
                          {event.origin_kind === "voice_action" ? <p className={`mt-1 max-w-xs text-xs ${body}`}>{voiceReview?.status.detail || "Delivery not confirmed here. Signup is not confirmed."}</p> : null}
                        </td>
                        <td className="px-6 py-4 text-sm">
                          <p className={`mb-2 text-xs ${body}`}>{event.origin_kind === "voice_action" ? "Voice call → SMS" : "Conversation"}</p>
                          {event.origin_kind === "voice_action" && event.source_conversation_id ? <Link href={`/conversations?conversation=${encodeURIComponent(event.source_conversation_id)}`} className="mb-2 block font-medium text-[var(--brand-accent)] underline dark:text-[var(--brand-accent-dark)]">View call</Link> : null}
                          {event.conversation_id ? (
                            <Link
                              href={`/conversations?conversation=${encodeURIComponent(event.conversation_id)}`}
                              className="font-medium text-[var(--brand-accent)] transition-colors hover:text-[var(--brand-primary-active)] dark:text-[var(--brand-accent-dark)] dark:hover:text-[var(--brand-primary-soft-dark)]"
                            >
                              {event.origin_kind === "voice_action" ? "View text conversation" : "View conversation"}
                            </Link>
                          ) : (
                            <span className={body}>Conversation unavailable</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function currentBusinessMonth(now: Date, requestedTimeZone: unknown): MonthRange {
  const timeZone = validTimeZone(requestedTimeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  return {
    start: businessWallTimeToInstant(
      `${year}-${String(month).padStart(2, "0")}-01`,
      "00:00:00",
      timeZone
    ).toISOString(),
    end: businessWallTimeToInstant(
      `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
      "00:00:00",
      timeZone
    ).toISOString(),
    timeZone,
  };
}

function validTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return "UTC";
  }
}

function formatOccurredAt(
  value: string,
  timeZone: string
): { date: string; time: string } {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return { date: "Unknown date", time: "Unknown time" };
  }

  return {
    date: new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone,
    }).format(instant),
    time: new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(instant),
  };
}

function contactDisplay(contact: LeadEventContact | null): string {
  const name = contact?.name?.trim();
  if (name) return name;

  const phone = contact?.phone_number?.trim();
  if (phone) return formatPhoneNumber(phone);

  const email = contact?.email?.trim();
  if (email) return email;

  return "Contact unavailable";
}
