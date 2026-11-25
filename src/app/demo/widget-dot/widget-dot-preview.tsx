"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import WidgetConfigForm, { type WidgetConfigFormValues } from "@/components/widget/WidgetConfigForm";
import { buildPreviewPayload } from "@/components/widget/WidgetPreview";
import { body, card, ink } from "@/lib/theme-v2/theme";
import type { WidgetConfig } from "@/types/database";

// A made-up widget. The form edits it in memory only.
const DEMO_CONFIG: WidgetConfig = {
  id: "00000000-0000-4000-8000-00000000d071",
  business_id: "00000000-0000-4000-8000-00000000d070",
  brand_color: "#6163F7",
  position: "bottom_right",
  welcome_message: "Hi there! 👋 How can we help you today?",
  proactive_invitation_enabled: true,
  show_logo: true,
  logo_url: null,
  mascot_color: "#FFFFFF",
  lead_capture_enabled: false,
  lead_capture_timing: "after_3_messages",
  quick_replies: ["Book a free consultation", "What services do you offer?"],
  allowed_hostnames: ["example.com"],
  is_active: true,
  created_at: "2026-11-25T00:00:00.000Z",
  updated_at: "2026-11-25T00:00:00.000Z",
};

export function WidgetDotPreview() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [values, setValues] = useState<WidgetConfigFormValues | null>(null);

  // The same message the dashboard's live preview sends to the widget script.
  const push = useCallback(() => {
    if (!values) return;
    frame.current?.contentWindow?.postMessage(
      { source: "simplassist-widget-preview", type: "apply-preview", payload: buildPreviewPayload(values) },
      window.location.origin,
    );
  }, [values]);

  useEffect(() => { push(); }, [push]);

  // The frame says when the widget script is listening; send the form again then.
  useEffect(() => {
    const ready = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.source === "sa-demo-widget-frame") push();
    };
    window.addEventListener("message", ready);
    return () => window.removeEventListener("message", ready);
  }, [push]);

  return (
    <main className="mx-auto grid max-w-7xl gap-6 xl:grid-cols-[minmax(0,1fr)_620px]">
      <section className={`p-6 ${card}`}>
        <h1 className={`text-2xl font-bold ${ink}`}>Widget dot preview</h1>
        <p className={`mt-2 mb-6 text-sm ${body}`}>
          The real settings form and the real widget, with canned replies. Change “Dot Color” and the brand
          color and watch the widget on the right. Saving and logo upload do not work on this page.
        </p>
        <WidgetConfigForm config={DEMO_CONFIG} onPreviewChange={setValues} />
      </section>
      <aside className="order-first xl:order-none xl:sticky xl:top-6 xl:self-start">
        <iframe ref={frame} title="Widget preview" src="/demo/widget-dot/frame"
          className="h-[640px] w-full rounded-2xl border border-[#ece4d8] bg-white dark:border-white/[0.12]" />
        <p className={`mt-2 text-xs ${body}`}>
          Move the pointer over the widget, click into the message box, type, and send.
        </p>
      </aside>
    </main>
  );
}
