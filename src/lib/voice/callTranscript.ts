export interface VoiceTranscriptTurn {
  id: string;
  role: "customer" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
  overlapsPrevious: boolean;
}

export interface VoiceCallTranscript {
  conversationId: string;
  callInProgress: boolean;
  turns: VoiceTranscriptTurn[];
  truncated: boolean;
}

export interface VoiceCallTranscriptFragment {
  id: string;
  eventId: string;
  role: VoiceTranscriptTurn["role"];
  text: string;
  startMs: number;
  endMs: number;
}

const MAX_CONTINUOUS_GAP_MS = 1200;
const MAX_TURN_CHARACTERS = 16000;

/** Display grouping only. A turn never proves that a request was completed. */
export function groupVoiceCallTranscript(
  fragments: readonly VoiceCallTranscriptFragment[],
): VoiceTranscriptTurn[] {
  const byId = new Map<string, VoiceCallTranscriptFragment>();
  const byEvent = new Map<string, VoiceCallTranscriptFragment>();
  for (const fragment of fragments) {
    const duplicate = byId.get(fragment.id) || byEvent.get(fragment.eventId);
    if (duplicate) {
      if (duplicate.id !== fragment.id || duplicate.eventId !== fragment.eventId ||
        duplicate.role !== fragment.role || duplicate.text !== fragment.text ||
        duplicate.startMs !== fragment.startMs || duplicate.endMs !== fragment.endMs) {
        throw new Error("voice_transcript_conflict");
      }
      continue;
    }
    byId.set(fragment.id, fragment);
    byEvent.set(fragment.eventId, fragment);
  }
  const ordered = Array.from(byId.values()).sort((a, b) =>
    a.startMs - b.startMs || a.endMs - b.endMs ||
    compareText(a.eventId, b.eventId) || compareText(a.id, b.id));

  const turns: VoiceTranscriptTurn[] = [];
  let lastFragmentEndMs = 0;
  let precedingEndMs = 0;
  for (const fragment of ordered) {
    const previous = turns.at(-1);
    if (previous && previous.role === fragment.role &&
      fragment.startMs - lastFragmentEndMs <= MAX_CONTINUOUS_GAP_MS &&
      previous.text.length + fragment.text.length <= MAX_TURN_CHARACTERS) {
      // Provider deltas already carry their whitespace. Inserting spaces or
      // trimming each chunk would corrupt split words, punctuation and emails.
      previous.text += fragment.text;
      previous.endMs = Math.max(previous.endMs, fragment.endMs);
    } else {
      turns.push({
        id: fragment.id, role: fragment.role, text: fragment.text,
        startMs: fragment.startMs, endMs: fragment.endMs,
        overlapsPrevious: fragment.startMs < precedingEndMs,
      });
    }
    lastFragmentEndMs = fragment.endMs;
    precedingEndMs = Math.max(precedingEndMs, fragment.endMs);
  }
  return turns;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
