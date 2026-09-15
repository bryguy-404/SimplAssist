import { describe, expect, it } from "vitest";
import { buildBusinessFacts, buildSystemPrompt } from "../ai/prompt";
import { buildVoiceAnswerPrompt, LIVE_INSTRUCTIONS } from "./knowledge";
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
