"use client";

import { useEffect } from "react";

const DEMO_BUSINESS_ID = "00000000-0000-4000-8000-00000000d070";

const CANNED_CONFIG = {
  available: true,
  businessName: "Bryan Develops",
  brandColor: "#6163F7",
  position: "bottom_right",
  welcomeMessage: "Hi there! 👋 How can we help you today?",
  showLogo: true,
  logoUrl: null,
  mascotColor: null,
  proactiveInvitationEnabled: true,
  leadCaptureEnabled: false,
  leadCaptureTiming: "after_3_messages",
  quickReplies: ["Book a free consultation", "What services do you offer?"],
};

const CANNED_REPLIES = [
  "Happy to help! This is a canned reply for the preview, so no AI was asked.",
  "Good question. On a real site the assistant would answer from the business's own details.",
  "Got it. Anything else you'd like to try?",
];

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
}

/**
 * Loads the real widget script in preview mode and answers its requests here,
 * so the page needs no sign-in, database, or AI.
 */
export function DemoWidgetFrame() {
  useEffect(() => {
    const frameWindow = window as typeof window & { __saDemoWidgetFrame?: boolean };
    if (frameWindow.__saDemoWidgetFrame) return;
    frameWindow.__saDemoWidgetFrame = true;

    const realFetch = window.fetch.bind(window);
    let replies = 0;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/widget/preview-config")) return Promise.resolve(json(CANNED_CONFIG));
      if (url.includes("/api/widget/chat")) {
        const response = CANNED_REPLIES[replies++ % CANNED_REPLIES.length];
        return new Promise((resolve) => {
          window.setTimeout(() => resolve(json({ available: true, response })), 1600);
        });
      }
      if (url.includes("/api/widget/")) return Promise.resolve(json({ ok: true }));
      return realFetch(input, init);
    };

    const script = document.createElement("script");
    script.src = `/widget/embed.js?v=${Date.now()}`;
    script.setAttribute("data-business-id", DEMO_BUSINESS_ID);
    script.setAttribute("data-preview", "true");
    script.onload = () => window.parent.postMessage({ source: "sa-demo-widget-frame" }, window.location.origin);
    document.body.appendChild(script);
  }, []);

  return (
    <div className="p-5 text-center text-sm text-stone-500">
      A pretend website. The chat widget below is the real one.
    </div>
  );
}
