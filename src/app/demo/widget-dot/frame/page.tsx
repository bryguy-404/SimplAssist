import { assertDemoPagesEnabled } from "../../_lib/guard";
import { DemoWidgetFrame } from "./demo-widget-frame";

/** The page inside the /demo/widget-dot preview frame: a blank site with the widget on it. */

export const dynamic = "force-dynamic";

export default function DemoWidgetFramePage() {
  assertDemoPagesEnabled();
  return <DemoWidgetFrame />;
}
