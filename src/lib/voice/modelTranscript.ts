import type { ActionContext } from "./actions";
import type { TranscriptFragment } from "./types";

const MAX_CONTEXT_CHARS = 24000;
const MAX_SEGMENT_FRAGMENTS = 20;
const MAX_FRAGMENT_GAP_MS = 1200;

interface Segment {
  number: number;
  role: TranscriptFragment["role"];
  fragments: TranscriptFragment[];
  startMs: number;
  endMs: number;
}

function line(segment: Segment): string {
  // Quoting preserves literal delta text while keeping caller-supplied newlines
  // and fake segment labels inside the untrusted content of one physical line.
  const content = JSON.stringify(segment.fragments.map((f) => f.text).join(""));
  return `${segment.role === "customer" ? "Caller" : "Spoken assistant"} [segment ${segment.number}] [${segment.startMs}-${segment.endMs} ms]: ${content}`;
}

/** Compact presentation only: a segment is never proof of a complete turn. */
export function buildModelTranscript(
  fragments: readonly TranscriptFragment[],
  context: ActionContext,
): {
  text: string;
  resolveCallerSegments: (refs: number[]) => string[];
  playbackSegment: (eventId: string) => number | undefined;
} {
  // Capture primitives now; later provider events or caller mutation cannot
  // change the evidence represented by this particular model request.
  const captured = fragments
    .map((fragment) => ({ ...fragment }))
    .sort(
      (a, b) =>
        a.startMs - b.startMs ||
        a.endMs - b.endMs ||
        a.eventId.localeCompare(b.eventId),
    );
  const pending = context.actions.filter(
    (action) => action.status === "awaiting_confirmation",
  );
  const cutoffs = pending
    .map((action) => action.playback_caller_end_ms)
    .filter(
      (value): value is number => value !== null && Number.isFinite(value),
    );
  const anchors = new Set(
    pending.flatMap((action) =>
      action.playback_event_id ? [action.playback_event_id] : [],
    ),
  );
  const segments: Segment[] = [];
  for (const fragment of captured) {
    const previous = segments.at(-1);
    const tail = previous?.fragments.at(-1);
    const crossesCallerCutoff =
      fragment.role === "customer" &&
      tail &&
      cutoffs.some(
        (cutoff) => tail.startMs < cutoff && fragment.startMs >= cutoff,
      );
    if (
      previous &&
      tail &&
      previous.role === fragment.role &&
      previous.fragments.length < MAX_SEGMENT_FRAGMENTS &&
      fragment.startMs - tail.endMs <= MAX_FRAGMENT_GAP_MS &&
      !crossesCallerCutoff &&
      !(tail.role === "assistant" && anchors.has(tail.eventId))
    ) {
      const extended = {
        ...previous,
        fragments: [...previous.fragments, fragment],
        endMs: Math.max(previous.endMs, fragment.endMs),
      };
      // An unusually long contiguous reply can still be retained by whole
      // fragments; never create an oversized combined line if splitting helps.
      if (line(extended).length <= MAX_CONTEXT_CHARS) {
        segments[segments.length - 1] = extended;
        continue;
      }
    }
    segments.push({
      number: segments.length + 1,
      role: fragment.role,
      fragments: [fragment],
      startMs: fragment.startMs,
      endMs: fragment.endMs,
    });
  }

  const retained: Segment[] = [];
  const lines: string[] = [];
  let length = 0;
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    const rendered = line(segment);
    const nextLength = length + rendered.length + (lines.length ? 1 : 0);
    if (nextLength > MAX_CONTEXT_CHARS) break;
    retained.unshift(segment);
    lines.unshift(rendered);
    length = nextLength;
  }
  const byNumber = new Map(
    retained.map((segment) => [segment.number, segment]),
  );
  const assistantSegments = new Map(
    retained.flatMap((segment) =>
      segment.role === "assistant"
        ? segment.fragments.map(
            (fragment) => [fragment.eventId, segment.number] as const,
          )
        : [],
    ),
  );

  return {
    text: lines.join("\n"),
    resolveCallerSegments(refs) {
      const invalid = () => new Error("invalid_transcript_evidence");
      if (
        !Array.isArray(refs) ||
        refs.length === 0 ||
        new Set(refs).size !== refs.length ||
        refs.some((ref) => !Number.isInteger(ref) || ref < 1)
      )
        throw invalid();
      const ids: string[] = [];
      for (const ref of [...refs].sort((a, b) => a - b)) {
        const segment = byNumber.get(ref);
        if (!segment || segment.role !== "customer") throw invalid();
        ids.push(...segment.fragments.map((fragment) => fragment.eventId));
        if (ids.length > 100) throw invalid();
      }
      if (new Set(ids).size !== ids.length) throw invalid();
      return ids;
    },
    playbackSegment: (eventId) => assistantSegments.get(eventId),
  };
}
