import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isSameOriginWidgetPreview,
  isWidgetOriginAllowed,
  normalizeWidgetOrigin,
  parseConfiguredWidgetHostnames,
} from "./origin.server";

describe("widget origin policy", () => {
  it.each([
    ["https://Example.COM", { origin: "https://example.com", hostname: "example.com" }],
    ["https://example.com:8443", { origin: "https://example.com:8443", hostname: "example.com" }],
    ["http://localhost:3000", { origin: "http://localhost:3000", hostname: "localhost" }],
    ["https://xn--bcher-kva.example", { origin: "https://xn--bcher-kva.example", hostname: "xn--bcher-kva.example" }],
  ])("normalizes a valid browser origin %s", (raw, expected) => {
    expect(normalizeWidgetOrigin(raw)).toEqual(expected);
  });

  it.each([
    null,
    "",
    "null",
    " https://example.com",
    "https://example.com/",
    "https://example.com/path",
    "https://example.com?x=1",
    "https://example.com#x",
    "https://user@example.com",
    "ftp://example.com",
    "https://example.com, https://evil.test",
    "https://example.com\n",
    "https://[::1]",
  ])("rejects malformed or unsafe Origin input %j", (raw) => {
    expect(normalizeWidgetOrigin(raw)).toBeNull();
  });

  it("requires canonical exact configured hostnames", () => {
    expect(parseConfiguredWidgetHostnames(["example.com", "www.example.com"]))
      .toEqual(["example.com", "www.example.com"]);
    expect(parseConfiguredWidgetHostnames([])).toEqual([]);
    expect(parseConfiguredWidgetHostnames(["Example.com"])).toBeNull();
    expect(parseConfiguredWidgetHostnames(["https://example.com"])).toBeNull();
    expect(parseConfiguredWidgetHostnames(["*.example.com"])).toBeNull();
    expect(parseConfiguredWidgetHostnames(["example.com:443"])).toBeNull();
    expect(parseConfiguredWidgetHostnames(["example.com", "example.com"]))
      .toBeNull();
    expect(parseConfiguredWidgetHostnames(Array(11).fill("example.com")))
      .toBeNull();
  });

  it("matches only an exact allowed hostname", () => {
    const allowed = ["example.com"];
    expect(
      isWidgetOriginAllowed(normalizeWidgetOrigin("https://example.com")!, allowed),
    ).toBe(true);
    expect(
      isWidgetOriginAllowed(
        normalizeWidgetOrigin("https://www.example.com")!,
        allowed,
      ),
    ).toBe(false);
    expect(
      isWidgetOriginAllowed(
        normalizeWidgetOrigin("https://example.com.evil.test")!,
        allowed,
      ),
    ).toBe(false);
  });

  it("permits the preview bypass only on the endpoint's own exact origin", () => {
    const request = new Request("https://app.alphadogagency.ai/api/widget/chat", {
      headers: { Host: "app.alphadogagency.ai" },
    });
    expect(
      isSameOriginWidgetPreview(
        request,
        normalizeWidgetOrigin("https://app.alphadogagency.ai")!,
      ),
    ).toBe(true);
    expect(
      isSameOriginWidgetPreview(
        request,
        normalizeWidgetOrigin("https://simplassist.com")!,
      ),
    ).toBe(false);
  });

  it.each(["simplassist.com", "app.alphadogagency.ai", "localhost:3000"])(
    "recognizes the exact public preview origin behind a proxy: %s",
    (host) => {
      const request = new Request("http://railway.internal:8080/api/widget/chat", {
        headers: { Host: host, "X-Forwarded-Proto": "https" },
      });
      expect(isSameOriginWidgetPreview(request, normalizeWidgetOrigin(`https://${host}`)!))
        .toBe(true);
      for (const origin of ["https://evil.example", `http://${host}`, "http://railway.internal:8080"]) {
        expect(isSameOriginWidgetPreview(request, normalizeWidgetOrigin(origin)!))
          .toBe(false);
      }
    },
  );

  it.each([
    {},
    { Host: "simplassist.com" },
    { Host: "simplassist.com", "X-Forwarded-Proto": "https,http" },
    { Host: "simplassist.com", "X-Forwarded-Proto": "" },
    { Host: "https://simplassist.com", "X-Forwarded-Proto": "https" },
    { Host: "simplassist.com,evil.example", "X-Forwarded-Proto": "https" },
    { Host: "simplassist.com:8443", "X-Forwarded-Proto": "https" },
    { Host: "evil.example", "X-Forwarded-Host": "simplassist.com", "X-Forwarded-Proto": "https" },
  ])("rejects ambiguous or mismatched proxy preview headers %j", (headers) => {
    const request = new Request("http://railway.internal:8080/api/widget/chat", {
      headers: headers as HeadersInit,
    });
    expect(isSameOriginWidgetPreview(request, normalizeWidgetOrigin("https://simplassist.com")!))
      .toBe(false);
  });
});
