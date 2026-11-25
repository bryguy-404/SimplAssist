import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import WidgetPreview, { buildPreviewPayload } from "./WidgetPreview";

const BASE_VALUES = {
  brand_color: "#123456",
  position: "bottom_right" as const,
  show_logo: false,
  logo_url: "",
  mascot_color: "#FACC15",
  welcome_message: "Hello",
  proactive_invitation_enabled: true,
  lead_capture_enabled: true,
  lead_capture_timing: "after_3_messages" as const,
  quick_replies: ["Pricing", ""],
  allowed_hostnames: ["example.com"],
  is_active: true,
};

describe("widget live preview payload", () => {
  it.each([true, false])(
    "forwards proactiveInvitationEnabled=%s without persisting the form",
    (enabled) => {
      expect(
        buildPreviewPayload({
          ...BASE_VALUES,
          proactive_invitation_enabled: enabled,
        }),
      ).toMatchObject({
        welcomeMessage: "Hello",
        mascotColor: "#FACC15",
        proactiveInvitationEnabled: enabled,
        forceProactiveInvitationOpen: enabled,
        quickReplies: ["Pricing"],
      });
    },
  );

  it("offers explicit desktop and mobile viewport controls", () => {
    const html = renderToStaticMarkup(
      createElement(WidgetPreview, {
        businessId: "00000000-0000-4000-8000-000000000001",
        preview: BASE_VALUES,
      }),
    );

    expect(html).toContain('role="group" aria-label="Preview device"');
    expect(html).toContain("Desktop");
    expect(html).toContain("Mobile");
    expect(html).toContain('data-preview-device="desktop"');
  });
});
