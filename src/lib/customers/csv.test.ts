import { describe, expect, it } from "vitest";
import { parseCsv, prepareCsv, safeCsvCell, exportCustomersCsv } from "./csv";
import { customerDefaults, MAX_IMPORT_BYTES } from "./domain";
import type { Contact } from "@/types/database";
describe("bounded customer CSV import", () => {
  it("parses BOM, quoted commas, escaped quotes, multiline fields and CRLF", () => {
    expect(
      parseCsv('\uFEFFname,notes\r\n"Pat, Jr.","Said ""yes""\nFollow up"\r\n'),
    ).toEqual([
      ["name", "notes"],
      ["Pat, Jr.", 'Said "yes"\nFollow up'],
    ]);
  });
  it("rejects malformed quoting, oversized bytes and excessive records", () => {
    expect(() => parseCsv('name\n"Pat')).toThrow("incomplete");
    expect(() => parseCsv('name\n"Pat"x')).toThrow("quoting");
    expect(() => parseCsv("é".repeat(MAX_IMPORT_BYTES / 2 + 1))).toThrow(
      "5 MB",
    );
    expect(() => parseCsv("name\n" + "Pat\n".repeat(5001))).toThrow("5,000");
    expect(parseCsv("name\n" + "Pat\n".repeat(5000))).toHaveLength(5001);
  });
  it("maps explicit columns and omits ignored columns without retaining their data", () => {
    const result = prepareCsv(
      "Client,Mail,Private\nPat,PAT@EXAMPLE.COM,discard this",
      { name: "Client", email: "Mail", notes: "" },
    );
    expect(result.rows[0].values).toEqual({
      name: "Pat",
      email: "pat@example.com",
    });
    expect(JSON.stringify(result.rows)).not.toContain("discard this");
    expect(result.mapping).toEqual({ name: "Client", email: "Mail" });
  });
  it("surfaces invalid rows and refuses ambiguous mapping", () => {
    expect(prepareCsv("name,email\nPat,broken").rows[0].action).toBe(
      "conflict",
    );
    expect(
      prepareCsv("name,email\nPat,good@example.com,extra").rows[0].action,
    ).toBe("conflict");
    expect(() => prepareCsv("name,name\nPat,Pat")).toThrow("unique");
    expect(() =>
      prepareCsv("name\nPat", { name: "name", company: "name" }),
    ).toThrow("only once");
  });
});
describe("CSV export", () => {
  it("prevents formula execution even through leading whitespace and escapes quotes", () => {
    for (const value of [
      "=SUM(1,2)",
      "+cmd",
      "-42",
      "@SUM(A1)",
      "  =formula",
      "\ttext",
      "\rtext",
    ])
      expect(safeCsvCell(value).startsWith("\"'")).toBe(true);
    expect(safeCsvCell('A "quote"')).toBe('"A ""quote"""');
  });
  it("exports allowed customer fields only, with one optional header", () => {
    const row = customerDefaults({
      id: "secret-id",
      business_id: "secret-tenant",
      name: "Pat",
      email: null,
      phone_number: "+15745550101",
      notes: null,
      session_id: "secret-session",
      source_channel: "manual",
      lead_status: "normal",
      lead_status_updated_at: "2026-01-01",
      lead_score: 0,
      created_at: "2026-01-01",
      last_contacted_at: "2026-01-01",
    } satisfies Contact);
    expect(exportCustomersCsv([row])).not.toContain("secret");
    expect(exportCustomersCsv([row], false)).not.toContain('"source_channel"');
    expect(exportCustomersCsv([row])).toContain("'+15745550101");
  });
});

it("exports the real callback phone, never a synthetic widget identity", () => {
  const result = exportCustomersCsv([
    {
      ...customerDefaults({
        id: "widget",
        source_channel: "web_chat",
        phone_number: "session_abc",
        provided_phone_number: "+15745550959",
      } as Contact),
    },
  ]);
  expect(result).toContain("+15745550959");
  expect(result).not.toContain("session_abc");
});
