import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ServiceAgreementField, type ServiceAgreementControl } from "./ServiceAgreementField";

const control = (overrides: Partial<ServiceAgreementControl> = {}): ServiceAgreementControl => ({
  required: true, status: { accepted: false, termsVersion: "version", records: [] }, checked: false,
  setChecked: vi.fn(), refresh: vi.fn(), error: false, ready: false, confirmation: undefined, ...overrides,
});
describe("service agreement checkbox", () => {
  it("starts unchecked with the approved copy and separately opening document links", () => {
    const html = renderToStaticMarkup(<ServiceAgreementField agreement={control()} />);
    expect(html).toContain('type="checkbox"'); expect(html).not.toContain('checked=""');
    expect(html.replace(/<[^>]*>/g, "")).toBe("I agree to the Terms of Service and acknowledge the Privacy Policy.");
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
  });
  it("does not ask again for a current saved agreement or a nonpayment action", () => {
    expect(renderToStaticMarkup(<ServiceAgreementField agreement={control({ status: { accepted: true, termsVersion: "v", records: [] } })} />)).toBe("");
    expect(renderToStaticMarkup(<ServiceAgreementField agreement={control({ required: false })} />)).toBe("");
  });
  it("does not present a usable checkbox before the version has loaded", () => {
    expect(renderToStaticMarkup(<ServiceAgreementField agreement={control({ status: null })} />)).toContain("Loading agreement");
    const error = renderToStaticMarkup(<ServiceAgreementField agreement={control({ status: null, error: true })} />);
    expect(error).toContain("Try again"); expect(error).not.toContain('type="checkbox"');
  });
});
