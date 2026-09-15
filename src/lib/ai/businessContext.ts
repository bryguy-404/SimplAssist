import type { SupabaseClient } from "@supabase/supabase-js";

/** Shared, uncached business reads. The caller decides how to handle partial failures. */
export function loadBusinessContextResults(
  supabaseAdmin: SupabaseClient,
  businessId: string,
) {
  return Promise.all([
    supabaseAdmin.from("businesses").select("*").eq("id", businessId).single(),
    supabaseAdmin
      .from("ai_settings")
      .select("*")
      .eq("business_id", businessId)
      .single(),
    supabaseAdmin
      .from("services")
      .select("*")
      .eq("business_id", businessId)
      .eq("is_active", true),
    supabaseAdmin
      .from("faqs")
      .select("*")
      .eq("business_id", businessId)
      .eq("is_active", true),
    supabaseAdmin
      .from("business_hours")
      .select("*")
      .eq("business_id", businessId),
    supabaseAdmin
      .from("business_knowledge_items")
      .select(
        "id,business_id,kind,category,title,content,source,is_active,sort_order,verified_at,created_at,updated_at",
      )
      .eq("business_id", businessId)
      .eq("is_active", true)
      .eq("kind", "overview")
      .order("sort_order", { ascending: true })
      .order("verified_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(1),
    supabaseAdmin
      .from("business_knowledge_items")
      .select(
        "id,business_id,kind,category,title,content,source,is_active,sort_order,verified_at,created_at,updated_at",
      )
      .eq("business_id", businessId)
      .eq("is_active", true)
      .in("kind", ["fact", "policy"])
      .order("sort_order", { ascending: true })
      .order("verified_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(24),
    supabaseAdmin
      .from("google_calendar_tokens")
      .select("id")
      .eq("business_id", businessId)
      .maybeSingle(),
  ]);
}
