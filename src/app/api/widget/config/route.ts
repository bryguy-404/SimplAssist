import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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
import {
  OperationalControlsResolutionError,
  resolveBusinessOperationalControls,
  resolveOperationalBlockReason,
} from "@/lib/account/operationalControls.server";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { resolvePublicWidgetAccess } from "@/lib/widget/access.server";
import { requireWidgetEdgeOrigin } from "@/lib/widget/edgeOrigin.server";
import {
  normalizeWidgetOrigin,
  parseConfiguredWidgetHostnames,
  resolveWidgetRequestOrigin,
} from "@/lib/widget/origin.server";
import {
  applyWidgetResponseHeaders,
  parseExactWidgetQuery,
  parseWidgetJson,
  widgetErrorResponse,
  widgetOptionsResponse,
} from "@/lib/widget/request.server";
import { mintWidgetToken } from "@/lib/widget/token.server";
import { acquireWidgetIngressTraffic } from "@/lib/widget/ingressTraffic.server";
import { arePublicWidgetProactiveInvitationsEnabledForBusiness } from "@/lib/widget/proactiveInvitations.server";
import {
  acquireWidgetTraffic,
  deriveWidgetNetworkKey,
  deriveWidgetRequestKey,
} from "@/lib/widget/traffic.server";

const widgetConfigMutationSchema = z
  .object({
    brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    position: z.enum(["bottom_right", "bottom_left"]),
    show_logo: z.boolean(),
    logo_url: z.union([z.string().url(), z.literal(""), z.null()]),
    welcome_message: z.string().trim().min(1).max(500),
    proactive_invitation_enabled: z.boolean(),
    lead_capture_enabled: z.boolean(),
    lead_capture_timing: z.enum(["start", "after_3_messages", "on_booking"]),
    quick_replies: z.array(z.string().trim().max(50)).max(3),
    is_active: z.boolean(),
    allowed_hostnames: z
      .array(z.string())
      .max(10)
      .refine((value) => parseConfiguredWidgetHostnames(value) !== null)
      .optional(),
  })
  .strict();

function resolvePublicConfigOrigin(request: NextRequest) {
  const declaredOrigin = request.headers.get("origin");
  if (declaredOrigin !== null) {
    return normalizeWidgetOrigin(declaredOrigin);
  }

  // Browser scripts cannot forge Sec-Fetch-Site. Same-origin GETs may omit
  // Origin, while cross-origin embeds continue through the explicit branch.
  if (request.headers.get("sec-fetch-site") !== "same-origin") return null;

  return resolveWidgetRequestOrigin(request);
}

export async function OPTIONS(request: NextRequest) {
  const edgeRejection = requireWidgetEdgeOrigin(request);
  if (edgeRejection) return edgeRejection;

  const query = parseExactWidgetQuery(request);
  const origin = normalizeWidgetOrigin(request.headers.get("origin"));
  if (!query.ok || !origin) {
    return widgetErrorResponse("invalid_request", 400);
  }
  return widgetOptionsResponse(origin.origin, "GET");
}

export async function PATCH(request: NextRequest) {
  const workspace = await requireWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;

  const { business } = workspace.access;

  try {
    const entitlements = await resolveBusinessEntitlements(business.id);
    if (!canUseFeature(entitlements, "web_chat")) {
      return NextResponse.json(
        {
          error: "feature_unavailable",
          feature: "web_chat",
          requiredPlan: "sms_and_chat",
        },
        { status: 403 },
      );
    }
  } catch (error) {
    if (error instanceof EntitlementResolutionError) {
      return NextResponse.json(
        { error: "Service temporarily unavailable", retryable: true },
        { status: 503 },
      );
    }
    throw error;
  }

  const parsedPayload = await parseWidgetJson(
    request,
    widgetConfigMutationSchema,
  );
  if (!parsedPayload.ok) {
    return NextResponse.json(
      { error: "Invalid widget configuration" },
      { status: 400 },
    );
  }
  const payload = parsedPayload.data;

  if (payload.is_active) {
    let effectiveAllowedHostnames = payload.allowed_hostnames;
    if (effectiveAllowedHostnames === undefined) {
      const { data: currentConfig, error: currentConfigError } =
        await supabaseAdmin
          .from("widget_configs")
          .select("allowed_hostnames")
          .eq("business_id", business.id)
          .maybeSingle();
      if (currentConfigError) {
        console.error(
          "Widget hostname configuration lookup error:",
          currentConfigError,
        );
        return NextResponse.json(
          { error: "Service temporarily unavailable", retryable: true },
          { status: 503 },
        );
      }
      if (!currentConfig) {
        return NextResponse.json(
          { error: "Widget configuration not found" },
          { status: 404 },
        );
      }
      effectiveAllowedHostnames =
        parseConfiguredWidgetHostnames(currentConfig.allowed_hostnames) ??
        undefined;
    }
    if (!effectiveAllowedHostnames?.length) {
      return NextResponse.json(
        { error: "An allowed website hostname is required before activation" },
        { status: 400 },
      );
    }
  }

  const { data: widgetConfig, error: updateError } = await supabaseAdmin
    .from("widget_configs")
    .update({
      ...payload,
      logo_url: payload.logo_url || null,
      quick_replies: payload.quick_replies.filter(Boolean),
    })
    .eq("business_id", business.id)
    .select("*")
    .maybeSingle();

  if (updateError) {
    console.error("Widget config update error:", updateError);
    return NextResponse.json(
      { error: "Service temporarily unavailable", retryable: true },
      { status: 503 },
    );
  }
  if (!widgetConfig) {
    return NextResponse.json(
      { error: "Widget configuration not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ config: widgetConfig });
}

export async function GET(request: NextRequest) {
  try {
    const edgeRejection = requireWidgetEdgeOrigin(request);
    if (edgeRejection) return edgeRejection;

    const query = parseExactWidgetQuery(request);
    const origin = resolvePublicConfigOrigin(request);
    if (!query.ok || !origin) {
      return widgetErrorResponse("invalid_request", 400);
    }
    const { businessId, sessionId } = query.data;

    let networkKey: string;
    try {
      networkKey = deriveWidgetNetworkKey(request);
      const ingress = await acquireWidgetIngressTraffic({
        endpoint: "config",
        networkKey,
      });
      if (ingress.status === "unavailable") {
        return widgetErrorResponse("service_unavailable", 503);
      }
      if (ingress.status === "rate_limited") {
        return widgetErrorResponse("rate_limited", 429, {
          retryAfterSeconds: ingress.retryAfterSeconds,
        });
      }
    } catch (error) {
      console.error("Widget config ingress control failed:", error);
      return widgetErrorResponse("service_unavailable", 503);
    }

    const access = await resolvePublicWidgetAccess(businessId, origin);
    if (access.status === "unavailable") {
      return widgetErrorResponse("service_unavailable", 503);
    }
    if (access.status === "forbidden") {
      return widgetErrorResponse("origin_not_allowed", 403);
    }
    const widgetConfig = access.config;

    const traffic = await acquirePublicTraffic(request, {
      businessId,
      sessionId,
      originHostname: origin.hostname,
      networkKey,
    });
    if (traffic) return traffic;

    if (!widgetConfig.is_active) {
      return publicJson({ available: false }, origin.origin);
    }

    try {
      const entitlements = await resolveBusinessEntitlements(businessId);
      if (!canUseFeature(entitlements, "web_chat")) {
        return NextResponse.json(
          { available: false },
          { headers: publicHeaders(origin.origin) },
        );
      }
    } catch (error) {
      if (error instanceof EntitlementResolutionError) {
        return widgetErrorResponse("service_unavailable", 503, {
          origin: origin.origin,
        });
      }
      throw error;
    }

    const entryOperationalResponse = await widgetOperationalResponse(
      businessId,
      origin.origin,
    );
    if (entryOperationalResponse) return entryOperationalResponse;

    const { data: business, error: businessError } = await supabaseAdmin
      .from("businesses")
      .select("name")
      .eq("id", businessId)
      .maybeSingle();

    if (businessError) {
      console.error("Widget business lookup error:", businessError);
      return widgetErrorResponse("service_unavailable", 503, {
        origin: origin.origin,
      });
    }

    if (!business) {
      return publicJson({ available: false }, origin.origin);
    }

    let attribution;
    try {
      attribution = await resolveWidgetAttribution({
        businessId,
        hostHeader: request.headers.get("host"),
      });
    } catch (error) {
      if (error instanceof BusinessPartnerResolutionError) {
        console.error("Widget attribution lookup error:", error);
        return widgetErrorResponse("service_unavailable", 503, {
          origin: origin.origin,
        });
      }
      throw error;
    }

    // Attribution and business reads may be slow. Re-read immediately before
    // exposing an available configuration so a pause applied during either
    // await cannot leave a stale-enabled widget in an embed cache.
    const finalOperationalResponse = await widgetOperationalResponse(
      businessId,
      origin.origin,
    );
    if (finalOperationalResponse) return finalOperationalResponse;

    let token;
    try {
      token = mintWidgetToken({
        businessId,
        origin: origin.origin,
        sessionId,
      });
    } catch (error) {
      console.error("Widget token mint failed:", error);
      return widgetErrorResponse("service_unavailable", 503, {
        origin: origin.origin,
      });
    }

    return NextResponse.json(
      {
        available: true,
        businessName: business?.name || "Business",
        brandColor: widgetConfig.brand_color,
        position: widgetConfig.position,
        welcomeMessage: widgetConfig.welcome_message,
        showLogo: widgetConfig.show_logo,
        logoUrl: widgetConfig.logo_url,
        proactiveInvitationEnabled:
          widgetConfig.proactive_invitation_enabled &&
          arePublicWidgetProactiveInvitationsEnabledForBusiness(businessId),
        leadCaptureEnabled: widgetConfig.lead_capture_enabled,
        leadCaptureTiming: widgetConfig.lead_capture_timing,
        quickReplies: widgetConfig.quick_replies || [],
        widgetToken: token.token,
        widgetSessionNonce: token.sessionNonce,
        widgetTokenExpiresAt: token.expiresAt,
        ...attribution,
      },
      { headers: publicHeaders(origin.origin) },
    );
  } catch (error) {
    console.error("Widget config error:", error);
    return widgetErrorResponse("service_unavailable", 503);
  }
}

async function widgetOperationalResponse(
  businessId: string,
  origin: string,
): Promise<NextResponse | null> {
  try {
    const controls = await resolveBusinessOperationalControls(businessId);
    return resolveOperationalBlockReason(controls, ["ai_replies"]) === null
      ? null
      : publicJson({ available: false }, origin);
  } catch (error) {
    if (error instanceof OperationalControlsResolutionError) {
      console.error("Widget operational controls lookup error:", error);
      return widgetErrorResponse("service_unavailable", 503, { origin });
    }
    throw error;
  }
}

async function acquirePublicTraffic(
  request: NextRequest,
  input: {
    businessId: string;
    sessionId: string;
    originHostname: string;
    networkKey: string;
  },
): Promise<NextResponse | null> {
  try {
    const decision = await acquireWidgetTraffic({
      ...input,
      endpoint: "config",
      requestKey: deriveWidgetRequestKey({
        businessId: input.businessId,
        sessionId: input.sessionId,
        endpoint: "config",
      }),
    });
    if (decision.status === "allowed") return null;
    if (decision.status === "unavailable") {
      return widgetErrorResponse("service_unavailable", 503, {
        origin: normalizeWidgetOrigin(request.headers.get("origin"))?.origin,
      });
    }
    if (decision.status === "origin_not_allowed") {
      return widgetErrorResponse("origin_not_allowed", 403);
    }
    if (decision.status === "widget_inactive") {
      return widgetErrorResponse("service_unavailable", 503, {
        origin: normalizeWidgetOrigin(request.headers.get("origin"))?.origin,
      });
    }
    return widgetErrorResponse("rate_limited", 429, {
      origin: normalizeWidgetOrigin(request.headers.get("origin"))?.origin,
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  } catch (error) {
    console.error("Widget config traffic control failed:", error);
    return widgetErrorResponse("service_unavailable", 503, {
      origin: normalizeWidgetOrigin(request.headers.get("origin"))?.origin,
    });
  }
}

function publicHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin,
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function publicJson(body: unknown, origin: string): NextResponse {
  return applyWidgetResponseHeaders(NextResponse.json(body), origin);
}
