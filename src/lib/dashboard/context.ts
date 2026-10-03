import "server-only";

import type {} from "react/canary";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import {
  EntitlementResolutionError,
  resolveBusinessEntitlements,
  type BusinessEntitlements,
} from "@/lib/billing/entitlements";
import { createClient } from "@/lib/supabase/server";
import type { Business } from "@/types/database";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type DashboardBusiness = Pick<
  Business,
  | "id"
  | "name"
  | "primary_goal"
  | "goal_url"
  | "website_url"
  | "call_forwarding_enabled"
  | "forward_to_number"
  | "call_forwarding_nudge_resolved_at"
  | "operations_suspended_at"
  | "ai_replies_paused_at"
  | "texting_paused_at"
  | "bookings_paused_at"
  | "telnyx_brand_id"
  | "brand_status"
  | "brand_status_updated_at"
  | "brand_rejection_reason"
  | "campaign_status"
  | "campaign_status_updated_at"
  | "campaign_rejection_reason"
  | "onboarding_registration_status"
  | "slug"
  | "phone_number"
  | "email"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "opt_in_description"
  | "review_sms_signup_enabled"
  | "privacy_terms_mode"
  | "privacy_url_override"
  | "terms_url_override"
  | "timezone"
  | "partner_id"
  | "billing_mode"
> & {
  deleted_at: string | null;
};

export type DashboardBusinessContext =
  | {
      status: "unauthenticated";
      supabase: ServerSupabaseClient;
      user: null;
    }
  | {
      status: "business_lookup_failed";
      supabase: ServerSupabaseClient;
      user: User;
      error: unknown;
    }
  | {
      status: "business_not_found";
      supabase: ServerSupabaseClient;
      user: User;
    }
  | {
      status: "resolved";
      supabase: ServerSupabaseClient;
      user: User;
      business: DashboardBusiness;
    };

export type DashboardEntitledContext =
  | Exclude<DashboardBusinessContext, { status: "resolved" }>
  | (Omit<Extract<DashboardBusinessContext, { status: "resolved" }>, "status"> & {
      status: "subscription_missing";
    })
  | (Extract<DashboardBusinessContext, { status: "resolved" }> & {
      entitlements: BusinessEntitlements;
    });

export type DashboardPageEntitlementResult =
  | { status: "resolved"; entitlements: BusinessEntitlements }
  | { status: "subscription_missing" };

const DASHBOARD_BUSINESS_SELECT = [
  "id",
  "name",
  "primary_goal",
  "goal_url",
  "website_url",
  "deleted_at",
  "call_forwarding_enabled",
  "forward_to_number",
  "call_forwarding_nudge_resolved_at",
  "operations_suspended_at",
  "ai_replies_paused_at",
  "texting_paused_at",
  "bookings_paused_at",
  "telnyx_brand_id",
  "brand_status",
  "brand_status_updated_at",
  "brand_rejection_reason",
  "campaign_status",
  "campaign_status_updated_at",
  "campaign_rejection_reason",
  "onboarding_registration_status",
  "slug",
  "phone_number",
  "email",
  "address",
  "city",
  "state",
  "zip",
  "opt_in_description",
  "review_sms_signup_enabled",
  "privacy_terms_mode",
  "privacy_url_override",
  "terms_url_override",
  "timezone",
  "partner_id",
  "billing_mode",
].join(", ");

export const getDashboardIdentity = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { supabase, user };
});

export const getDashboardBusinessContext = cache(
  async (): Promise<DashboardBusinessContext> => {
    const { supabase, user } = await getDashboardIdentity();

    if (!user) {
      return { status: "unauthenticated", supabase, user: null };
    }

    const { data: business, error } = await supabase
      .from("businesses")
      .select(DASHBOARD_BUSINESS_SELECT)
      .eq("owner_id", user.id)
      .maybeSingle<DashboardBusiness>();

    if (error) {
      return {
        status: "business_lookup_failed",
        supabase,
        user,
        error,
      };
    }

    if (!business) {
      return { status: "business_not_found", supabase, user };
    }

    return { status: "resolved", supabase, user, business };
  }
);

export const getDashboardEntitlements = cache(
  async (businessId: string): Promise<BusinessEntitlements> =>
    resolveBusinessEntitlements(businessId)
);

/**
 * Page-safe entitlement resolution for the legitimate direct pre-checkout
 * state. Only an exact missing synchronized subscription becomes a redirect
 * signal; malformed state and database failures still surface as real errors.
 */
export const getDashboardPageEntitlements = cache(
  async (businessId: string): Promise<DashboardPageEntitlementResult> => {
    try {
      return {
        status: "resolved",
        entitlements: await getDashboardEntitlements(businessId),
      };
    } catch (error) {
      if (
        error instanceof EntitlementResolutionError &&
        error.code === "subscription_missing"
      ) {
        return { status: "subscription_missing" };
      }
      throw error;
    }
  }
);

export const getDashboardEntitledContext = cache(
  async (): Promise<DashboardEntitledContext> => {
    const context = await getDashboardBusinessContext();
    if (context.status !== "resolved") return context;

    const entitlementResult = await getDashboardPageEntitlements(
      context.business.id
    );
    if (entitlementResult.status === "subscription_missing") {
      return { ...context, status: "subscription_missing" };
    }

    return { ...context, entitlements: entitlementResult.entitlements };
  }
);
