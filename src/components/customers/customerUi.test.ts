import { afterEach, describe, expect, it, vi } from "vitest";
import {
  customerName,
  customerPhone,
  customerQuery,
  customerRequest,
  DEFAULT_FILTERS,
} from "./customerUi";

afterEach(() => vi.unstubAllGlobals());
describe("customer workspace requests", () => {
  it("uses captured phone details without exposing a web-chat session identity", () => {
    expect(
      customerPhone({
        phone_number: "session_abc",
        provided_phone_number: "+15745550123",
      }),
    ).toBe("+15745550123");
    expect(customerPhone({ phone_number: "session_abc" })).toBeNull();
    expect(
      customerPhone({
        phone_number: "+15745550999",
        provided_phone_number: "+15745550123",
      }),
    ).toBe("+15745550999");
    expect(
      customerPhone({
        phone_number: "+15745550999",
        provided_phone_number: "+15745550123",
        source_channel: "web_chat",
      }),
    ).toBe("+15745550123");
    expect(
      customerPhone({
        phone_number: "session_abc",
        provided_phone_number: "(574) 555-0123",
      }),
    ).toBe("+15745550123");
    expect(
      customerName({
        name: null,
        company: null,
        email: null,
        phone_number: "session_abc",
      }),
    ).toBe("Unnamed customer");
  });
  it("keeps search, source, tag and pagination in the server query without treating input as query syntax", () => {
    const query = new URLSearchParams(
      customerQuery(
        {
          q: " Ada & Sons ",
          view: "follow_up_due",
          tag: "web, repeat",
          source: "csv_import",
        },
        3,
      ),
    );
    expect(Object.fromEntries(query)).toEqual({
      q: "Ada & Sons",
      view: "follow_up_due",
      tag: "web, repeat",
      source: "csv_import",
      page: "3",
      pageSize: "25",
    });
    expect(
      new URLSearchParams(customerQuery(DEFAULT_FILTERS)).has("source"),
    ).toBe(false);
  });
  it("does not treat server rejection or non-JSON errors as a successful customer mutation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "customer_identity_conflict" }), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      customerRequest("/api/customers", { method: "POST", body: "{}" }),
    ).rejects.toThrow("matches another customer");
    await expect(customerRequest("/api/customers")).rejects.toThrow(
      "couldn’t complete",
    );
    expect(fetcher.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  it("preserves cancellation signals so stale pages cannot replace a newer search", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ customers: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    await customerRequest("/api/customers", { signal: controller.signal });
    expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
