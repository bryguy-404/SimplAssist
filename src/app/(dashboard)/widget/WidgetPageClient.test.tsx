import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WidgetConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({ widgetPreview: vi.fn() }));

vi.mock("@/components/widget/WidgetConfigForm", () => ({
  default: () => <div>Config form</div>,
}));
vi.mock("@/components/widget/WidgetPreview", () => ({
  default: (props: unknown) => {
    mocks.widgetPreview(props);
    return <div>Widget preview</div>;
  },
}));
vi.mock("@/components/widget/EmbedCodeGenerator", () => ({
  default: ({
    businessId,
    scriptOrigin,
  }: {
    businessId: string;
    scriptOrigin: string;
  }) => (
    <div data-business-id={businessId} data-script-origin={scriptOrigin} />
  ),
}));

import WidgetPageClient from "./WidgetPageClient";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";

const CONFIG: WidgetConfig = {
  id: "00000000-0000-4000-8000-000000000002",
  business_id: BUSINESS_ID,
  brand_color: "#123456",
  position: "bottom_right",
  welcome_message: "Hello",
  proactive_invitation_enabled: true,
  show_logo: false,
  logo_url: null,
  mascot_color: "#FFFFFF",
  lead_capture_enabled: true,
  lead_capture_timing: "after_3_messages",
  quick_replies: [],
  allowed_hostnames: ["example.com"],
  is_active: true,
  created_at: "2026-08-03T00:00:00.000Z",
  updated_at: "2026-08-03T00:00:00.000Z",
};

describe("WidgetPageClient install origin", () => {
  it("forwards the server-resolved origin to the embed generator", () => {
    const html = renderToStaticMarkup(
      <WidgetPageClient
        config={CONFIG}
        businessId={BUSINESS_ID}
        businessName="Acme"
        scriptOrigin="https://app.partner.example"
      />,
    );

    expect(html).toContain('data-script-origin="https://app.partner.example"');
    expect(html).toContain(`data-business-id="${BUSINESS_ID}"`);
    expect(mocks.widgetPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: expect.objectContaining({
          proactive_invitation_enabled: true,
        }),
      }),
    );
  });
});
