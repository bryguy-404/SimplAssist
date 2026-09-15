import type { TranscriptFragment } from "./types";

export class CallTranscript {
  private fragments = new Map<string, TranscriptFragment>();
  latestCallerEndMs = 0;
  add(fragment: TranscriptFragment): boolean {
    if (this.fragments.has(fragment.eventId)) return false;
    if (
      !fragment.eventId ||
      !fragment.text ||
      fragment.text.length > 16000 ||
      !Number.isFinite(fragment.startMs) ||
      !Number.isFinite(fragment.endMs) ||
      fragment.startMs < 0 ||
      fragment.endMs < fragment.startMs
    )
      throw new Error("invalid_transcript_fragment");
    if (this.fragments.size >= 5000) throw new Error("transcript_limit");
    this.fragments.set(fragment.eventId, fragment);
    if (fragment.role === "customer")
      this.latestCallerEndMs = Math.max(this.latestCallerEndMs, fragment.endMs);
    return true;
  }
  snapshot(): string {
    // Sorting is a display/context convention. It is never an action boundary.
    return Array.from(this.fragments.values())
      .sort(
        (a, b) =>
          a.startMs - b.startMs ||
          a.endMs - b.endMs ||
          a.eventId.localeCompare(b.eventId),
      )
      .map(
        (f) =>
          `${f.role === "customer" ? "Caller" : "Spoken assistant"} [${f.startMs}-${f.endMs}ms]: ${f.text}`,
      )
      .join("\n")
      .slice(-24000);
  }
  get hasCallerText() {
    return Array.from(this.fragments.values()).some(
      (f) => f.role === "customer",
    );
  }
}
