import type {
  Channel,
  KnowledgeGap,
  KnowledgeGapStatus,
} from "@/types/database";

export type KnowledgeGapFilter = "all" | KnowledgeGapStatus;

export type KnowledgeGapSort = "most_asked" | "newest";

export interface KnowledgeGapCounts {
  open: number;
  resolved: number;
  dismissed: number;
}

type KnowledgeGapStatusRow = Pick<KnowledgeGap, "status">;

type KnowledgeGapSortRow = Pick<
  KnowledgeGap,
  "id" | "occurrence_count" | "last_seen_at"
>;

export function getKnowledgeGapCounts(
  gaps: readonly KnowledgeGapStatusRow[]
): KnowledgeGapCounts {
  return gaps.reduce<KnowledgeGapCounts>(
    (counts, gap) => {
      counts[gap.status] += 1;
      return counts;
    },
    { open: 0, resolved: 0, dismissed: 0 }
  );
}

export function filterKnowledgeGaps<T extends KnowledgeGapStatusRow>(
  gaps: readonly T[],
  filter: KnowledgeGapFilter
): T[] {
  if (filter === "all") return [...gaps];

  return gaps.filter((gap) => gap.status === filter);
}

export function sortKnowledgeGaps<T extends KnowledgeGapSortRow>(
  gaps: readonly T[],
  sort: KnowledgeGapSort
): T[] {
  return [...gaps].sort((a, b) => {
    if (sort === "most_asked") {
      const occurrenceDifference =
        b.occurrence_count - a.occurrence_count;

      if (occurrenceDifference !== 0) return occurrenceDifference;
    }

    const recencyDifference =
      toTimestamp(b.last_seen_at) - toTimestamp(a.last_seen_at);
    if (recencyDifference !== 0) return recencyDifference;

    return a.id.localeCompare(b.id);
  });
}

export function formatTimesAsked(occurrenceCount: number): string {
  return `Asked ${occurrenceCount} ${
    occurrenceCount === 1 ? "time" : "times"
  }`;
}

export function formatKnowledgeGapChannel(channel: Channel): string {
  return channel === "voice" ? "Voice" : channel === "sms" ? "SMS" : "Web Chat";
}

export function formatKnowledgeGapLastSeen(
  value: string,
  timeZone: string
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";

  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  };

  try {
    return new Intl.DateTimeFormat("en-US", options).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      timeZone: "UTC",
    }).format(date);
  }
}

export function canManageKnowledgeGap(status: KnowledgeGapStatus): boolean {
  return status === "open";
}

export function resolveKnowledgeGapInList<T extends KnowledgeGap>(
  gaps: readonly T[],
  gapId: string,
  faqId: string
): T[] {
  return gaps.map((gap) =>
    gap.id === gapId
      ? {
          ...gap,
          status: "resolved",
          resolved_faq_id: faqId,
        } as T
      : gap
  );
}

export function dismissKnowledgeGapInList<T extends KnowledgeGap>(
  gaps: readonly T[],
  gapId: string
): T[] {
  return gaps.map((gap) =>
    gap.id === gapId
      ? {
          ...gap,
          status: "dismissed",
          resolved_faq_id: null,
        } as T
      : gap
  );
}

function toTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
