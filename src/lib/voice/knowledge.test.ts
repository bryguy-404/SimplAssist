import { describe, expect, it } from "vitest";
import { buildBusinessFacts, buildSystemPrompt } from "../ai/prompt";
import { buildVoiceAnswerPrompt } from "./knowledge";
import { buildLiveGreeting, buildLiveInstructions, LIVE_INSTRUCTIONS } from "./conversationStyle";
import type {
  Business,
  AISettings,
  Service,
  BusinessKnowledgeItem,
} from "@/types/database";

const business = {
  id: "a",
  name: "Test Business",
  business_type: "general",
  timezone: "America/Indiana/Indianapolis",
  phone_number: "+15742638634",
  primary_goal: "book",
} as Business;
const settings = {
  tone: "balanced",
  guardrails: ["give legal advice"],
  language: "en",
  business_voice: "we",
  booking_enabled: true,
} as AISettings;
const services = [
  { name: "Consultation", price: "50", is_active: true },
] as Service[];
const knowledge = [
  {
    id: "k",
    kind: "overview",
    content: "Consultation costs $99",
    is_active: true,
    sort_order: 0,
    verified_at: "2026-09-01",
  },
  { id: "off", kind: "fact", content: "SECRET DRAFT", is_active: false },
] as BusinessKnowledgeItem[];

describe("shared voice knowledge", () => {
  it("uses one flexible business AI greeting without inventing recording notice evidence", () => {
    const greeting = buildLiveGreeting();
    expect(greeting).toContain("still give the brief business/AI identification");
    expect(greeting).toContain("address it without another help question");
    expect(Buffer.byteLength(greeting, "utf8")).toBeLessThanOrEqual(500);
    const instructions = buildLiveInstructions("Lakeview Plumbing", false, true, true, false, true);
    expect(instructions).toContain("Lakeview Plumbing’s AI assistant");
    expect(instructions).toContain("Small phrasing variations are welcome");
    expect(instructions).toContain("no recording announcement is configured");
    expect(instructions).toContain("If asked about recording, explain it truthfully");
    expect(instructions).not.toContain("already heard");
    expect(instructions).not.toContain("previously acknowledged");
    expect(instructions).not.toContain("public opening phase");
  });
  it("distinguishes prior tester acknowledgment from a notice played on this call", () => {
    expect(buildLiveInstructions("Lakeview Plumbing", true)).toContain(
      "previously acknowledged",
    );
    expect(buildLiveInstructions("Lakeview Plumbing", true)).not.toContain(
      "already heard",
    );
    expect(buildLiveInstructions("Lakeview Plumbing", false)).toContain(
      "already heard",
    );
  });
  it("uses the same approved fact renderer as text, with structured precedence", () => {
    const voice = buildVoiceAnswerPrompt(
      business,
      settings,
      services,
      [],
      [],
      knowledge,
    );
    const sms = buildSystemPrompt(
      business,
      settings,
      services,
      [],
      [],
      false,
      "sms",
      true,
      knowledge,
    );
    const facts = buildBusinessFacts(
      business,
      services,
      [],
      [],
      knowledge,
    ).join("\n");
    expect(voice).toContain(facts);
    expect(sms).toContain(facts);
    expect(voice).toContain("($50)");
    expect(voice).toContain("take precedence");
    expect(voice).not.toContain("SECRET DRAFT");
  });
  it("answers from updated facts without enabling text side effects", () => {
    const voice = buildVoiceAnswerPrompt(
      business,
      settings,
      [{ ...services[0], price: "75" }],
      [],
      [],
      [],
    );
    expect(voice).toContain("($75)");
    expect(voice).not.toContain("($50)");
    expect(voice).toContain("Missing information means unknown");
    expect(voice).toContain("no action tools");
    expect(voice).not.toContain("save_contact_name");
    expect(voice).not.toContain("create_booking");
    expect(LIVE_INSTRUCTIONS).toContain(
      "Delegate every business-specific question",
    );
  });
});
