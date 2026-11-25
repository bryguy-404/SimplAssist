import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  canUseFeature,
  EntitlementResolutionError,
  resolveBusinessEntitlements,
} from "@/lib/billing/entitlements";
import {
  BusinessPartnerResolutionError,
  resolveWidgetAttribution,
} from "@/lib/branding/businessPartner.server";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
};

export async function GET(request: NextRequest) {
  const workspace = await requireWorkspaceRouteAccess();
  if (!workspace.ok) return withPrivateHeaders(workspace.response);

  const businessId = request.nextUrl.searchParams.get("businessId");
  if (!businessId) {
    return NextResponse.json(
      { error: "Missing businessId parameter" },
      { status: 400, headers: privateHeaders }
    );
  }

  const supabase = await createClient();

  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id, name")
    .eq("id", businessId)
    .eq("owner_id", workspace.access.user.id)
    .maybeSingle();

  if (businessError) {
    console.error("Widget preview business lookup error:", businessError);
    return NextResponse.json(
      { error: "Service temporarily unavailable", retryable: true },
      { status: 503, headers: privateHeaders }
    );
  }
  if (!business) {
    return NextResponse.json(
      { error: "Widget preview not found" },
      { status: 404, headers: privateHeaders }
    );
  }

  try {
    const entitlements = await resolveBusinessEntitlements(businessId);
    if (!canUseFeature(entitlements, "web_chat")) {
      return NextResponse.json(
        {
          error: "feature_unavailable",
          feature: "web_chat",
          requiredPlan: "sms_and_chat",
        },
        { status: 403, headers: privateHeaders }
      );
    }
  } catch (error) {
    if (error instanceof EntitlementResolutionError) {
      return NextResponse.json(
        { error: "Service temporarily unavailable", retryable: true },
        { status: 503, headers: privateHeaders }
      );
    }
    throw error;
  }

  const { data: widgetConfig, error: widgetError } = await supabaseAdmin
    .from("widget_configs")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();

  if (widgetError) {
    console.error("Widget preview config lookup error:", widgetError);
    return NextResponse.json(
      { error: "Service temporarily unavailable", retryable: true },
      { status: 503, headers: privateHeaders }
    );
  }
  if (!widgetConfig) {
    return NextResponse.json(
      { error: "Widget preview not found" },
      { status: 404, headers: privateHeaders }
    );
  }

  let attribution;
  try {
    attribution = await resolveWidgetAttribution({
      businessId,
      hostHeader: request.headers.get("host"),
    });
  } catch (error) {
    if (error instanceof BusinessPartnerResolutionError) {
      console.error("Widget preview attribution lookup error:", error);
      return NextResponse.json(
        { error: "Service temporarily unavailable", retryable: true },
        { status: 503, headers: privateHeaders }
      );
    }
    throw error;
  }

  return NextResponse.json(
    {
      available: true,
      businessName: business.name || "Business",
      brandColor: widgetConfig.brand_color,
      position: widgetConfig.position,
      welcomeMessage: widgetConfig.welcome_message,
      showLogo: widgetConfig.show_logo,
      logoUrl: widgetConfig.logo_url,
      mascotColor: widgetConfig.mascot_color ?? null,
      proactiveInvitationEnabled:
        widgetConfig.proactive_invitation_enabled,
      leadCaptureEnabled: widgetConfig.lead_capture_enabled,
      leadCaptureTiming: widgetConfig.lead_capture_timing,
      quickReplies: widgetConfig.quick_replies || [],
      ...attribution,
    },
    { headers: privateHeaders }
  );
}

function withPrivateHeaders(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(privateHeaders)) {
    response.headers.set(name, value);
  }
  return response;
}
