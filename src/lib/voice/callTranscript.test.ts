import { describe, expect, it } from "vitest";
import { groupVoiceCallTranscript, type VoiceCallTranscriptFragment } from "./callTranscript";

function fragment(id: string, text: string, startMs: number, endMs = startMs + 100,
  role: VoiceCallTranscriptFragment["role"] = "customer"): VoiceCallTranscriptFragment {
  return { id, eventId: `event-${id}`, text, startMs, endMs, role };
}

describe("readable voice transcript grouping", () => {
  it("preserves exact chunks, split words, punctuation, whitespace and email spelling", () => {
    const chunks = [" Hi", ",", " thanks", "! My e", "mail is ", "Jo", ".", "Smith", "+", "test", "@", "example", ".", "com", ". ", "\nYes."];
    const result = groupVoiceCallTranscript(chunks.map((text, index) => fragment(String(index), text, index * 100)));
    expect(result).toEqual([{ id: "0", role: "customer", text: chunks.join(""), startMs: 0, endMs: 1600, overlapsPrevious: false }]);
  });

  it("sorts late and reordered fragments by audio time, then end and event identity", () => {
    const pieces = [fragment("d", " done", 200), fragment("b", " again", 100), fragment("a", "Start", 100), fragment("c", " please", 100, 250)];
    const before = structuredClone(pieces);
    expect(groupVoiceCallTranscript(pieces)[0]).toMatchObject({ id: "a", text: "Start again please done", startMs: 100, endMs: 300 });
    expect(groupVoiceCallTranscript([...pieces].reverse())).toEqual(groupVoiceCallTranscript(pieces));
    expect(pieces).toEqual(before);
  });

  it("splits at a speaker change and at a meaningful pause, not a page boundary", () => {
    expect(groupVoiceCallTranscript([
      fragment("a", "Hi", 0), fragment("b", " there", 1300),
      fragment("c", "New thought", 2601), fragment("d", "Hello", 2800, 2900, "assistant"),
      fragment("e", "Yes", 3000),
    ]).map(({ text, role }) => ({ text, role }))).toEqual([
      { text: "Hi there", role: "customer" }, { text: "New thought", role: "customer" },
      { text: "Hello", role: "assistant" }, { text: "Yes", role: "customer" },
    ]);
  });

  it("retains overlap even when an earlier long fragment spans multiple following turns", () => {
    const turns = groupVoiceCallTranscript([
      fragment("a", "Assistant starts", 0, 3000, "assistant"),
      fragment("b", "Wait", 500, 800),
      fragment("c", "Yes?", 900, 1200, "assistant"),
      fragment("d", "Later", 3200, 3400),
    ]);
    expect(turns.map(({ overlapsPrevious }) => overlapsPrevious)).toEqual([false, true, true, false]);
    expect(turns[0].endMs).toBe(3000);
    expect(turns.map(({ text }) => text)).toEqual(["Assistant starts", "Wait", "Yes?", "Later"]);
  });

  it("deduplicates identical identities while preserving actual spoken repetitions", () => {
    const first = fragment("one", "Yes", 0);
    const repeated = fragment("two", " yes", 100);
    expect(groupVoiceCallTranscript([first, { ...first }, repeated])[0].text).toBe("Yes yes");
  });

  it("does not silently choose between contradictory copies of the same fragment", () => {
    const first = fragment("one", "Yes", 0);
    expect(() => groupVoiceCallTranscript([first, { ...first, text: "No" }])).toThrow("voice_transcript_conflict");
    expect(() => groupVoiceCallTranscript([first, { ...first, id: "other" }])).toThrow("voice_transcript_conflict");
  });

  it("splits unusually long presentation turns without discarding or rewriting any text", () => {
    const chunks = ["a".repeat(15999), "bc", "<script>not markup</script>"];
    const turns = groupVoiceCallTranscript(chunks.map((text, index) => fragment(String(index), text, index * 100)));
    expect(turns).toHaveLength(2);
    expect(turns.map(({ text }) => text).join("")).toBe(chunks.join(""));
  });

  it("handles an empty transcript and does not invent words for empty fragments", () => {
    expect(groupVoiceCallTranscript([])).toEqual([]);
    expect(groupVoiceCallTranscript([fragment("empty", "", 0), fragment("space", " ", 100)])[0].text).toBe(" ");
  });
});
