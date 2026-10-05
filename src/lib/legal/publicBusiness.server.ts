import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { isPendingSlug } from "@/lib/util/slug.shared";
import type { Language } from "@/types/database";

// Street and postal code are deliberately absent. They are fetched separately
// only for businesses that explicitly retain the existing full-address display.
export const PUBLIC_BUSINESS_PROJECTION =
  "id, slug, name, business_type, email, phone_number, city, state, public_address_visibility, legal_business_name, shared_registration_id, review_sms_signup_enabled, ai_settings(language)";

export interface PublicBusiness {
  id: string;
  slug: string;
  name: string;
  business_type: string;
  email: string | null;
  phone_number: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  legal_operator_name: string | null;
  review_sms_signup_enabled: boolean;
  ai_settings: { language: Language } | null;
}

type PublicBusinessRow = Omit<PublicBusiness, "address" | "zip" | "legal_operator_name"> & {
  public_address_visibility?: "full" | "city_state";
  shared_registration_id?: string | null;
  legal_business_name?: string | null;
};

/** Anonymous pages receive this allowlisted result, never a raw business row.
 * The shared legal name is a guarded snapshot; the registration itself and its
 * private identity fields must not cross the public render boundary. */
export async function loadPublicBusiness(slug: string): Promise<PublicBusiness | null> {
  if (isPendingSlug(slug)) return null;
  const { data, error } = await supabaseAdmin.from("businesses")
    .select(PUBLIC_BUSINESS_PROJECTION).eq("slug", slug).maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as PublicBusinessRow;

  let postal: { address: string | null; zip: string | null } | null = null;
  if (row.public_address_visibility === "full") {
    const result = await supabaseAdmin.from("businesses").select("address, zip")
      .eq("id", row.id).eq("public_address_visibility", "full").maybeSingle();
    if (result.error) throw new Error("Unable to load public business address");
    postal = result.data;
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    business_type: row.business_type,
    email: row.email,
    phone_number: row.phone_number,
    address: postal?.address ?? null,
    city: row.city,
    state: row.state,
    zip: postal?.zip ?? null,
    legal_operator_name: row.shared_registration_id ? row.legal_business_name ?? null : null,
    review_sms_signup_enabled: row.review_sms_signup_enabled === true,
    ai_settings: row.ai_settings ? { language: row.ai_settings.language } : null,
  };
}
