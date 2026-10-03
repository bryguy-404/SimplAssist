import { describe, expect, it } from "vitest";
import {
  customerDefaults,
  customerPatchSchema,
  duplicateDecision,
  effectiveWarmth,
  filtersFromParams,
  normalizePhone,
} from "./domain";
import type { Contact } from "@/types/database";
const base = customerDefaults({
  id: "a",
  business_id: "b",
  name: "Pat",
  email: "pat@example.com",
  phone_number: "+15745550101",
  source_channel: "sms",
  lead_status: "hot",
  lead_score: 0,
  lead_status_updated_at: "2026-01-01",
  notes: null,
  session_id: null,
  created_at: "2026-01-01",
  last_contacted_at: "2026-01-01",
} satisfies Contact);
describe("customer validation and identity", () => {
  it("normalizes destinations without collapsing distinct email aliases", () => {
    expect(
      customerPatchSchema.parse({
        email: " Pat+Job@Example.com ",
        phone_number: "(574) 555-0101",
        tags: [" VIP ", "vip"],
      }),
    ).toEqual({
      email: "pat+job@example.com",
      phone_number: "+15745550101",
      tags: ["vip"],
    });
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(() => normalizePhone("123")).toThrow();
  });
  it("rejects tenant, source, session, consent and managed classification writes", () => {
    for (const key of [
      "business_id",
      "source_channel",
      "session_id",
      "lead_status",
      "consent",
      "provided_phone_number",
    ])
      expect(customerPatchSchema.safeParse({ [key]: "anything" }).success).toBe(
        false,
      );
  });
  it("uses an explicit manual override without mutating automatic warmth", () => {
    expect(effectiveWarmth({ ...base, owner_warmth_override: "normal" })).toBe(
      "normal",
    );
    expect(effectiveWarmth(base)).toBe("hot");
    expect(base.lead_status).toBe("hot");
  });
  it("does not merge shared-name people or inconsistent destinations", () => {
    expect(duplicateDecision({ name: "Pat" }, [base], 2).action).toBe("create");
    expect(
      duplicateDecision(
        { email: "pat@example.com", phone_number: "+15745550999" },
        [base],
        2,
      ).action,
    ).toBe("conflict");
    expect(
      duplicateDecision(
        { email: "pat@example.com" },
        [base, { ...base, id: "c" }],
        2,
      ).action,
    ).toBe("conflict");
  });
  it("fills only blank fields and preserves customer status and manual warmth", () => {
    expect(
      duplicateDecision(
        {
          email: base.email,
          name: "Replacement",
          owner_warmth_override: "normal",
        },
        [base],
        2,
      ).action,
    ).toBe("skip");
    expect(
      duplicateDecision({ email: base.email, company: "Example" }, [base], 2)
        .action,
    ).toBe("fill_blanks");
  });
  it("validates views without leaking raw query syntax into database filters", () => {
    expect(
      filtersFromParams(new URLSearchParams("q=%25%2C%28&view=hot&tag=VIP")),
    ).toEqual({ q: "%,(", view: "hot", tag: "vip" });
    expect(() =>
      filtersFromParams(new URLSearchParams("view=other")),
    ).toThrow();
  });
});
