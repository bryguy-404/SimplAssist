import type { Metadata } from "next";
import { ThemeToggleV2 } from "@/lib/theme-v2/ui";
import { darkAmbient, fontStack, lightAmbient, pageShell } from "@/lib/theme-v2/theme";
import { assertDemoPagesEnabled } from "../_lib/guard";
import { WidgetDotPreview } from "./widget-dot-preview";

/**
 * /demo/widget-dot — an isolated visual review page for the chat widget's dot
 * mascot and its colour setting. Dev-only. It runs the real settings form and
 * the real widget script against canned answers: nothing is saved, and no
 * message reaches the AI.
 */

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  assertDemoPagesEnabled();
  return {
    title: "Widget dot preview (dev only)",
    robots: { index: false, follow: false },
  };
}

export default function DemoWidgetDotPage() {
  assertDemoPagesEnabled();

  return (
    <div className={`${pageShell} isolate p-6`} style={{ fontFamily: fontStack }}>
      <div className="pointer-events-none fixed inset-0 -z-10 dark:hidden" style={{ background: lightAmbient }} />
      <div className="pointer-events-none fixed inset-0 -z-10 hidden dark:block" style={{ background: darkAmbient }} />
      <div className="mb-4 flex justify-end"><ThemeToggleV2 /></div>
      <WidgetDotPreview />
    </div>
  );
}
