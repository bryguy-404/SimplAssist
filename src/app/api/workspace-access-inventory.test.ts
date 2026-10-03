import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type RouteInventory = {
  path: string;
  methods: Array<"GET" | "POST" | "PATCH" | "DELETE">;
};

const REQUIRED_ROUTES: RouteInventory[] = [
  { path: "./account/route.ts", methods: ["DELETE"] },
  { path: "./account/reactivate/route.ts", methods: ["POST"] },
  { path: "./billing/checkout/route.ts", methods: ["POST"] },
  { path: "./billing/finalize/route.ts", methods: ["POST"] },
  { path: "./billing/portal/route.ts", methods: ["POST"] },
  { path: "./booking-requests/[id]/handle/route.ts", methods: ["POST"] },
  {
    path: "./calendar/events/route.ts",
    methods: ["GET", "POST", "PATCH", "DELETE"],
  },
  { path: "./conversations/[id]/route.ts", methods: ["DELETE"] },
  { path: "./google/auth/route.ts", methods: ["GET"] },
  { path: "./google/complete/route.ts", methods: ["GET"] },
  { path: "./google/disconnect/route.ts", methods: ["POST"] },
  { path: "./messaging/numbers/purchase/route.ts", methods: ["POST"] },
  { path: "./messaging/numbers/search/route.ts", methods: ["GET"] },
  { path: "./messaging/send/route.ts", methods: ["POST"] },
  { path: "./onboarding/brand-verification/route.ts", methods: ["POST"] },
  { path: "./onboarding/business-info/route.ts", methods: ["POST"] },
  { path: "./onboarding/refresh-status/route.ts", methods: ["POST"] },
  { path: "./onboarding/retry-registration/route.ts", methods: ["POST"] },
  { path: "./onboarding/sms-use-case/route.ts", methods: ["POST"] },
  { path: "./onboarding/state/route.ts", methods: ["GET"] },
  { path: "./onboarding/submit-registration/route.ts", methods: ["POST"] },
  { path: "./scrape/route.ts", methods: ["POST"] },
  { path: "./settings/call-forwarding/route.ts", methods: ["POST"] },
  { path: "./settings/call-forwarding/nudge/route.ts", methods: ["POST"] },
  { path: "./settings/business-info/route.ts", methods: ["POST"] },
  { path: "./settings/compliance/route.ts", methods: ["POST"] },
  { path: "./settings/goal/route.ts", methods: ["POST"] },
  { path: "./website-scans/route.ts", methods: ["POST"] },
  { path: "./website-scans/current/route.ts", methods: ["GET"] },
  { path: "./website-scans/[scanId]/route.ts", methods: ["GET"] },
  { path: "./website-scans/[scanId]/review/route.ts", methods: ["PATCH"] },
  { path: "./website-scans/[scanId]/publish/route.ts", methods: ["POST"] },
  { path: "./website-scans/[scanId]/cancel/route.ts", methods: ["POST"] },
  { path: "./website-scans/[scanId]/retry/route.ts", methods: ["POST"] },
  { path: "./widget/logo/route.ts", methods: ["POST"] },
  { path: "./widget/preview-config/route.ts", methods: ["GET"] },
];

function routeSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function handlerSource(source: string, method: string): string {
  const marker = `export async function ${method}`;
  const start = source.indexOf(marker);
  if (start === -1) return "";

  const nextHandler = source.indexOf(
    "export async function ",
    start + marker.length,
  );
  return source.slice(start, nextHandler === -1 ? undefined : nextHandler);
}

describe("authenticated API workspace-access inventory", () => {
  for (const route of REQUIRED_ROUTES) {
    for (const method of route.methods) {
      it(`${method} ${route.path} gates before every other awaited operation`, () => {
        const handler = handlerSource(routeSource(route.path), method);
        const gate = handler.search(/await require(?:Fresh)?WorkspaceRouteAccess\(\)/);

        expect(handler).not.toBe("");
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBe(handler.indexOf("await "));
      });
    }
  }

  it("gates only widget config PATCH while GET and OPTIONS remain public", () => {
    const source = routeSource("./widget/config/route.ts");
    const patch = handlerSource(source, "PATCH");

    expect(patch.indexOf("await requireWorkspaceRouteAccess()")).toBe(
      patch.indexOf("await "),
    );
    expect(handlerSource(source, "GET")).not.toContain(
      "requireWorkspaceRouteAccess",
    );
    expect(handlerSource(source, "OPTIONS")).not.toContain(
      "requireWorkspaceRouteAccess",
    );
  });

  it("keeps live widget and provider/auth callback routes exempt", () => {
    for (const path of [
      "./widget/lead/route.ts",
      "./stripe/webhook/route.ts",
      "./messaging/webhook/route.ts",
      "./messaging/registration/status/route.ts",
      "./messaging/voice/route.ts",
      "./auth/callback/route.ts",
      "./google/callback/route.ts",
    ]) {
      expect(routeSource(path)).not.toContain("requireWorkspaceRouteAccess");
    }
  });

  it("keeps live widget chat public while authenticating preview chat", () => {
    const route = routeSource("./widget/chat/route.ts");
    const behavioralTests = routeSource("./widget/routes.test.ts");
    const previewFlag = route.indexOf("const verifiedPreview = preview === true");
    const previewGuard = route.indexOf("if (verifiedPreview)", previewFlag);
    const previewGate = route.indexOf(
      "await requireWorkspaceRouteAccess()",
      previewGuard,
    );
    const firstWidgetRead = route.indexOf('.from("widget_configs")');

    expect(previewFlag).toBeGreaterThan(-1);
    expect(previewGuard).toBeGreaterThan(previewFlag);
    expect(previewGate).toBeGreaterThan(previewGuard);
    expect(firstWidgetRead).toBeGreaterThan(previewGate);
    expect(behavioralTests).toContain(
      'it("serves an unauthenticated non-preview chat request without requiring workspace access"',
    );
    expect(behavioralTests).toContain(
      '"rejects an unverified preview with workspace %i before any chat read or AI work"',
    );
    expect(behavioralTests).toContain(
      'it("rejects a same-session preview marker for another workspace business before AI"',
    );
  });

  it("keeps live widget end public while authenticating preview end", () => {
    const route = routeSource("./widget/end/route.ts");
    const behavioralTests = routeSource("./widget/routes.test.ts");
    const previewFlag = route.indexOf("const verifiedPreview = preview === true");
    const previewGuard = route.indexOf("if (verifiedPreview)", previewFlag);
    const previewGate = route.indexOf(
      "await requireWorkspaceRouteAccess()",
      previewGuard,
    );
    const firstWidgetRead = route.indexOf('.from("widget_configs")');

    expect(previewFlag).toBeGreaterThan(-1);
    expect(previewGuard).toBeGreaterThan(previewFlag);
    expect(previewGate).toBeGreaterThan(previewGuard);
    expect(firstWidgetRead).toBeGreaterThan(previewGate);
    expect(behavioralTests).toContain(
      'it("requires the widget token on end-session before conversation reads"',
    );
    expect(behavioralTests).toContain(
      'it("allows authenticated same-business preview end without a public token"',
    );
  });

  it("protects the sessionless Google callback with exact canonical Host and atomic attempt staging", () => {
    const callback = handlerSource(
      routeSource("./google/callback/route.ts"),
      "GET",
    );
    const exactHost = callback.indexOf(
      'isExactCanonicalGoogleCallbackHost(request.headers.get("host"))',
    );
    const stage = callback.indexOf("await stageGoogleCalendarOAuthHandoff(");

    expect(exactHost).toBeGreaterThan(-1);
    expect(stage).toBeGreaterThan(exactHost);
    expect(stage).toBe(callback.indexOf("await "));
    expect(callback).not.toContain("supabaseAdmin");
    expect(callback).not.toContain(".rpc(");
  });

  it("uses optional workspace attribution for support tickets", () => {
    const source = routeSource("./support/route.ts");
    const optionalAccess = source.indexOf(
      "await getOptionalWorkspaceRouteAccess()",
    );
    const businessAttachment = source.indexOf('.from("businesses")');

    expect(optionalAccess).toBeGreaterThan(-1);
    expect(businessAttachment).toBeGreaterThan(optionalAccess);
  });
});
