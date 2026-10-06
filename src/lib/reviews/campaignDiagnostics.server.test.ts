import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { logCampaignError, serializeCampaignError } from "./campaignDiagnostics.server";

afterEach(() => vi.restoreAllMocks());

describe("campaign failure diagnostics", () => {
  it("retains Telnyx status, request ID, and provider errors without raw headers or request", () => {
    const error = Object.assign(new Error('400 {"request":{"address":"42 Private Lane"}}'), {
      status: 400,
      headers: new Headers({ "x-request-id": "req_safe_1234", authorization: "Bearer PRIVATE_TOKEN" }),
      error: { errors: [{ code: "10009", title: "Invalid campaign", detail: "sample1 must be at least 20 characters", source: { pointer: "/sample1" } }], request: { address: "42 Private Lane" } },
      request: { body: "PRIVATE_FILING" },
    });

    expect(serializeCampaignError(error)).toEqual({
      name: "Error",
      message: "400 [structured data omitted]",
      status: 400,
      requestId: "req_safe_1234",
      providerErrors: [{ code: "10009", title: "Invalid campaign", detail: "sample1 must be at least 20 characters", source: { pointer: "/sample1" } }],
    });
  });

  it("understands direct Telnyx errors and FastAPI validation details", () => {
    expect(serializeCampaignError({ status: 402, error: { code: 40001, title: "Payment required", detail: "Insufficient balance" } }).providerErrors)
      .toEqual([{ code: "40001", title: "Payment required", detail: "Insufficient balance" }]);
    expect(serializeCampaignError({ status: 422, error: { detail: [{ loc: ["body", "optoutKeywords"], msg: "Invalid value", type: "value_error", input: "PRIVATE_FILING" }] } }).providerErrors)
      .toEqual([{ code: "value_error", detail: "Invalid value", source: { pointer: "/body/optoutKeywords" } }]);
  });

  it("redacts sensitive text throughout errors and nested transport causes", () => {
    const detail = "Contact person@example.com +1 (212) 555-1234 EIN 12-3456789 or 123456789; address: 42 Private Lane; token=SUPER_SECRET; https://user:pass@example.com/path?key=QUERY_SECRET";
    const result = serializeCampaignError({
      message: "Rejected Acme Private LLC at 42 Private Lane using Bearer BEARER_SECRET",
      error: { errors: [{ detail, title: "Acme Private LLC" }] },
      cause: { name: "TypeError", message: "fetch failed at https://user:pass@example.com?token=SECRET", cause: { name: "Error", code: "ECONNRESET", message: "connection reset" } },
    }, { sensitiveValues: ["Acme Private LLC", "42 Private Lane"] });
    const text = JSON.stringify(result);
    for (const secret of ["person@example.com", "212", "12-3456789", "123456789", "Acme Private LLC", "42 Private Lane", "SUPER_SECRET", "QUERY_SECRET", "BEARER_SECRET", "user:pass"])
      expect(text).not.toContain(secret);
    expect(result.cause?.cause?.code).toBe("ECONNRESET");
    expect(result.message).toContain("Rejected [redacted]");
    expect(result.providerErrors[0].detail).toContain("[email]");
  });

  it("sanitizes token forms, encoded filing values, and hostile request IDs", () => {
    const result = serializeCampaignError({
      message: "KEYabcdefghijklmnopqrstuvwxyz sk_live_123abc eyJabc.def.ghi 42%20Private%20Lane",
      headers: { "x-request-id": "person@example.com", "authorization": "Bearer SECRET" },
    }, { sensitiveValues: ["42 Private Lane"] });
    expect(result.message).toBe("[credential] [credential] [credential] [redacted]");
    expect(result.requestId).toBeNull();
    expect(serializeCampaignError({ request_id: "safe-looking-secret" }, { sensitiveValues: ["safe-looking-secret"] }).requestId).toBeNull();
    expect(serializeCampaignError({ requestId: "KEYabcdefghijklmnopqrstuvwxyz" }).requestId).toBeNull();
    expect(serializeCampaignError({ requestId: "123456789" }).requestId).toBeNull();
    expect(serializeCampaignError({ message: "Phone +44 20 7123 4567 or +12125551234; EIN 12 3456789" }).message)
      .toBe("Phone [phone] or [phone]; EIN [tax-id]");
  });

  it("bounds provider lists, free text, causes and survives circular errors or throwing getters", () => {
    const error: Record<string, unknown> = {
      message: "x".repeat(2000),
      error: { errors: Array.from({ length: 30 }, () => ({ detail: "x".repeat(2000) })) },
    };
    error.cause = error;
    Object.defineProperty(error, "headers", { get() { throw new Error("private getter"); } });
    const result = serializeCampaignError(error);
    expect(result.message).toHaveLength(1000);
    expect(result.providerErrors).toHaveLength(8);
    expect(result.providerErrors[0].detail).toHaveLength(700);
    expect(result.cause?.cause?.cause).toBeUndefined();
    expect(JSON.stringify(result).length).toBeLessThan(8000);
    expect(serializeCampaignError({ message: "x".repeat(40000) }).message).toBe("[oversized diagnostic omitted]");
  });

  it("logs bounded correlation fields and the sanitized diagnostic as structured JSON", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const businessId = "10000000-0000-4000-a100-000000000001";
    const error = serializeCampaignError(new Error("private@example.com"));
    logCampaignError({ businessId, operationId: "PRIVATE_VALUE", referenceId: "Bearer SECRET", phase: "submit", error });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toBe("[reviews:campaign]");
    expect(JSON.parse(log.mock.calls[0][1])).toEqual({ event: "campaign_submission_failed", businessId, phase: "submit", error });
  });

  it("keeps Unicode-heavy diagnostics below the durable journal's byte limit", () => {
    const unicode = "界".repeat(2000);
    const result = serializeCampaignError({
      name: unicode, message: unicode,
      cause: { name: unicode, message: unicode, code: unicode, cause: { name: unicode, message: unicode, code: unicode } },
      error: { errors: Array.from({ length: 8 }, () => ({ code: unicode, title: unicode, detail: unicode, source: { pointer: unicode, parameter: unicode } })) },
    });
    expect(result.providerErrors.length).toBeGreaterThan(0);
    expect(result.providerErrorsTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(14_000);
  });

  it("retains the authorized corrected reference while rejecting other suffixes or private text", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const businessId = "10000000-0000-4000-a100-000000000001";
    const error = serializeCampaignError(new Error("Invalid campaign"));
    const base = `reviews:${businessId}`;
    for (const referenceId of [base, `${base}:r1`, `${base}:r2`, `${base}:r3`, `${base}:r2?token=PRIVATE_TOKEN`])
      logCampaignError({ businessId, referenceId, phase: "submit", error });
    expect(log.mock.calls.map(call => JSON.parse(call[1]).referenceId))
      .toEqual([base, `${base}:r1`, `${base}:r2`, undefined, undefined]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_TOKEN");
  });

  it("does not log extra properties even when added to an already serialized diagnostic", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(serializeCampaignError(new Error("Invalid email person@example.com; fix email")), {
      request: { body: "PRIVATE_FILING" },
    });
    logCampaignError({ businessId: "10000000-0000-4000-a100-000000000001", phase: "submit", error });
    const output = log.mock.calls[0][1] as string;
    expect(output).not.toContain("PRIVATE_FILING");
    expect(JSON.parse(output).error.message).toBe("Invalid email [email]; fix email");
  });
});
