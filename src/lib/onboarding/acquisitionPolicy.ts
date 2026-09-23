/** Provider evidence is distinct from a customer's unpurchased number choice. */
export function hasSmsProviderProvenance(args: {
  business: {
    telnyx_brand_id?: string | null;
    telnyx_campaign_id?: string | null;
    telnyx_messaging_profile_id?: string | null;
    telnyx_voice_application_id?: string | null;
    active_telnyx_release_run_id?: string | null;
    telnyx_resource_state?: string | null;
    brand_status?: string | null;
    campaign_status?: string | null;
    onboarding_registration_status?: string | null;
    onboarding_registration_started_at?: string | null;
    onboarding_registration_submitted_at?: string | null;
  };
  hasActivePhoneNumber: boolean;
}): boolean {
  const { business } = args;
  return Boolean(
    args.hasActivePhoneNumber ||
      business.telnyx_brand_id ||
      business.telnyx_campaign_id ||
      business.telnyx_messaging_profile_id ||
      business.telnyx_voice_application_id ||
      business.active_telnyx_release_run_id ||
      (business.telnyx_resource_state &&
        ["active", "parked", "release_pending", "releasing", "blocked", "protected_hold"].includes(
          business.telnyx_resource_state,
        )) ||
      business.brand_status ||
      business.campaign_status ||
      (business.onboarding_registration_status &&
        business.onboarding_registration_status !== "not_started") ||
      business.onboarding_registration_started_at ||
      business.onboarding_registration_submitted_at,
  );
}
