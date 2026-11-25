"use client";

import { useState } from "react";
import { FeedbackCard } from "@/components/dashboard/DashboardFeedback";
import { body, btnSecondaryInline, ink } from "@/lib/theme-v2/theme";

// Stands in for the real request: waits a moment, saves nothing.
const pretendToSend = () => new Promise<string>((resolve) => window.setTimeout(() => resolve("ok"), 600));

export function FeedbackPreview() {
  // Each replay gets a new key so the card starts over from its entrance.
  const [round, setRound] = useState(1);
  const [open, setOpen] = useState(true);

  return (
    <main className="max-w-md">
      <h1 className={`text-2xl font-bold ${ink}`}>Feedback card preview</h1>
      <p className={`mt-2 text-sm ${body}`}>
        This is the real card with a pretend send, so nothing here is saved or emailed. Move the pointer around,
        hover the faces, type a note, then send. “Great” and “Okay” get the confetti show; “Frustrating” gets a
        quiet thank-you.
      </p>
      <button type="button" className={`mt-4 ${btnSecondaryInline}`}
        onClick={() => { setRound((count) => count + 1); setOpen(true); }}>
        Show the card again
      </button>
      {open && (
        <FeedbackCard key={round} invitation={{ id: "demo", automatic: true }}
          close={() => setOpen(false)} send={pretendToSend} />
      )}
    </main>
  );
}
