import type { Metadata } from "next";
import { ThemeToggleV2 } from "@/lib/theme-v2/ui";
import { darkAmbient, fontStack, lightAmbient, pageShell } from "@/lib/theme-v2/theme";
import { assertDemoPagesEnabled } from "../_lib/guard";
import { FeedbackPreview } from "./feedback-preview";

/**
 * /demo/feedback — an isolated visual review page for the dashboard feedback
 * card and its dot mascot. Dev-only; it has no auth, persistence, or network
 * I/O: nothing typed here is saved or emailed.
 */

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  assertDemoPagesEnabled();
  return {
    title: "Feedback card preview (dev only)",
    robots: { index: false, follow: false },
  };
}

export default function DemoFeedbackPage() {
  assertDemoPagesEnabled();

  return (
    <div className={`${pageShell} isolate p-6`} style={{ fontFamily: fontStack }}>
      <div className="pointer-events-none fixed inset-0 -z-10 dark:hidden" style={{ background: lightAmbient }} />
      <div className="pointer-events-none fixed inset-0 -z-10 hidden dark:block" style={{ background: darkAmbient }} />
      <div className="mb-6 flex justify-end"><ThemeToggleV2 /></div>
      <FeedbackPreview />
    </div>
  );
}
