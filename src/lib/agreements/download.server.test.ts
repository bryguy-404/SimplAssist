import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ read: vi.fn(), access: vi.fn(), admin: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./service.server", () => ({ readServiceAgreement: mocks.read, ServiceAgreementError: class extends Error { code = "service_agreement_unavailable"; status = 503; } }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/admin/auth", () => ({ getAdminUser: mocks.admin }));
import { GET as customerDownload } from "@/app/api/service-agreements/[agreementId]/route";
import { GET as adminDownload } from "@/app/api/admin/businesses/[businessId]/service-agreements/[agreementId]/route";
const recordId = "12100000-0000-4000-8000-000000000001";
const html = "<article><h1>Terms of Service</h1><p>The historical accepted Terms.</p></article>";
const request = (query = "") => new NextRequest(`https://simplassist.com/api/service-agreements/${recordId}${query}`);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({ ok: true, access: { business: { id: "owned-business" }, user: { id: "subscriber" } } });
  mocks.admin.mockResolvedValue({ id: "admin" });
  mocks.read.mockResolvedValue({
    agreement: { id: recordId, business_id: "owned-business", subscriber_id: "subscriber", subscriber_email: "person@example.test", business_name: "<script>alert(1)</script>", terms_version: "historical-v1", accepted_at: "2026-11-12T12:34:56Z", source: "onboarding" },
    document: { terms_html: html, terms_sha256: createHash("sha256").update(html).digest("hex"), checkbox_text: "I agree to the Terms of Service and acknowledge the Privacy Policy.", terms_url: "https://simplassist.com/terms", privacy_url: "https://simplassist.com/privacy" },
    references: [{ kind: "stripe_checkout", reference: "cs_test_saved", recorded_at: "2026-11-12T12:35:00Z" }],
  });
});
describe("historical agreement downloads", () => {
  it("returns full historical text and submission details without a subscription requirement", async () => {
    const response = await customerDownload(request("?download=1&businessId=foreign"), { params: { agreementId: recordId } });
    expect(response.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith("owned-business", recordId);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.text();
    expect(body).toContain(html); expect(body).toContain("historical-v1");
    expect(body).toContain("2026-11-12T12:34:56.000Z"); expect(body).toContain("cs_test_saved");
    expect(body).not.toContain("<script>"); expect(body).toContain("&lt;script&gt;");
  });
  it("does not reveal a record outside the authorized business", async () => {
    mocks.read.mockResolvedValue(null);
    expect((await customerDownload(request(), { params: { agreementId: recordId } })).status).toBe(404);
  });
  it("requires sign-in before reading any customer record", async () => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 401 }) });
    expect((await customerDownload(request(), { params: { agreementId: recordId } })).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("requires the admin gate for owner downloads", async () => {
    mocks.admin.mockResolvedValue(null);
    expect((await adminDownload(request(), { params: { businessId: "owned-business", agreementId: recordId } })).status).toBe(401);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("serves the same saved record to the authorized admin", async () => {
    const response = await adminDownload(request(), { params: { businessId: "owned-business", agreementId: recordId } });
    expect(response.status).toBe(200); expect(await response.text()).toContain(html);
    expect(mocks.read).toHaveBeenCalledWith("owned-business", recordId);
  });
  it("refuses a corrupted archived document", async () => {
    const original = await mocks.read(); original.document.terms_html = "corrupted";
    mocks.read.mockResolvedValue(original);
    expect((await customerDownload(request(), { params: { agreementId: recordId } })).status).toBe(503);
  });
});
