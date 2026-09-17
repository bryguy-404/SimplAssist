import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceTranscriptContent, VoiceTranscriptPanel } from "./VoiceTranscript";
import type { VoiceCallTranscript } from "@/lib/voice/callTranscript";

const fixture = (): VoiceCallTranscript => ({
  conversationId: "call", callInProgress: false, truncated: false,
  turns: [
    { id: "a", role: "assistant", text: "How can I help you today?", startMs: 1000, endMs: 3600, overlapsPrevious: false },
    { id: "b", role: "customer", text: "Hi, I would like to sign up.", startMs: 3200, endMs: 5500, overlapsPrevious: true },
  ],
});

describe("voice transcript display", () => {
  it("shows complete turns with distinct speaker labels, times and overlap", () => {
    const html = renderToStaticMarkup(<VoiceTranscriptContent transcript={fixture()} />);
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).toContain("How can I help you today?");
    expect(html).toContain("Hi, I would like to sign up.");
    expect(html).toContain(">Caller</span>"); expect(html).toContain(">AI</span>");
    expect(html).toContain("0:01–0:03"); expect(html).toContain("Overlapping speech");
    expect(html).not.toMatch(/<textarea|Take Over|Let AI Handle|>Send</);
  });
  it("renders transcript content as text and wraps long details on mobile", () => {
    const data = fixture();
    data.turns[0].text = "<script>alert('hello')</script>\n" + "long".repeat(100) + "@example.test";
    const html = renderToStaticMarkup(<VoiceTranscriptContent transcript={data} />);
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>");
    expect(html).toContain("whitespace-pre-wrap"); expect(html).toContain("[overflow-wrap:anywhere]");
  });
  it("distinguishes a closed empty transcript from speech not received yet", () => {
    const data = { ...fixture(), turns: [] };
    expect(renderToStaticMarkup(<VoiceTranscriptContent transcript={data} />)).toContain("No transcript is available for this call.");
    const html = renderToStaticMarkup(<VoiceTranscriptContent transcript={{ ...data, callInProgress: true }} />);
    expect(html).toContain("No speech has been transcribed yet.");
    expect(html).toContain("updates automatically");
  });
  it("makes partial history explicit without claiming the full call is shown", () => {
    const html = renderToStaticMarkup(<VoiceTranscriptContent transcript={{ ...fixture(), truncated: true }} />);
    expect(html).toContain("Only part of this transcript is available here.");
    expect(html).toContain('role="status"');
  });
  it("has accessible loading and refresh controls", () => {
    const html = renderToStaticMarkup(<VoiceTranscriptPanel conversationId="call" />);
    expect(html).toContain('aria-label="Refresh call transcript"');
    expect(html).toContain('role="status"'); expect(html).toContain("Loading transcript");
  });
});
