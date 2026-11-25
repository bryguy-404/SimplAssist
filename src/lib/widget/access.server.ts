import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  isWidgetOriginAllowed,
  parseConfiguredWidgetHostnames,
  type NormalizedWidgetOrigin,
} from "./origin.server";

export type PublicWidgetConfigRow = {
  id: string;
  business_id: string;
  brand_color: string;
  position: "bottom_right" | "bottom_left";
  welcome_message: string;
  proactive_invitation_enabled: boolean;
  show_logo: boolean;
  logo_url: string | null;
  mascot_color?: string | null;
  lead_capture_enabled: boolean;
  lead_capture_timing: "start" | "after_3_messages" | "on_booking";
  quick_replies: string[] | null;
  is_active: boolean;
  allowed_hostnames: string[];
};

export type PublicWidgetAccessResult =
  | { status: "allowed"; config: PublicWidgetConfigRow }
  | { status: "forbidden" }
  | { status: "unavailable" };

/**
 * Resolves one public embed origin without revealing whether an unknown or
 * unauthorized business exists. Persisted allowlist corruption fails closed.
 */
export async function resolvePublicWidgetAccess(
  businessId: string,
  origin: NormalizedWidgetOrigin,
): Promise<PublicWidgetAccessResult> {
  const { data, error } = await supabaseAdmin
    .from("widget_configs")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();

  if (error) {
    console.error("Widget origin configuration lookup failed:", error);
    return { status: "unavailable" };
  }
  if (!data || typeof data !== "object") return { status: "forbidden" };

  const row = data as Record<string, unknown>;
  const allowedHostnames = parseConfiguredWidgetHostnames(
    row.allowed_hostnames,
  );
  if (!allowedHostnames) {
    console.error("Widget origin configuration is malformed", { businessId });
    return { status: "unavailable" };
  }
  if (!isWidgetOriginAllowed(origin, allowedHostnames)) {
    return { status: "forbidden" };
  }

  return {
    status: "allowed",
    config: { ...row, allowed_hostnames: allowedHostnames } as PublicWidgetConfigRow,
  };
}
