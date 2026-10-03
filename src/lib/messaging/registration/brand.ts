import { telnyx } from "@/lib/messaging/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { BusinessType, TelnyxBrandSource } from "@/types/database";
import { normalizeUsStateCode } from "@/lib/usStates";
import { appendRegistrationEvent, serializeError } from "./audit";
import { archiveAndClearRejectedCampaign } from "./campaign";
import { buildBusinessLandingUrl } from "./legalUrls";
import { toTelnyxEntityType } from "./identity";
import {
  deleteTelnyxBrand,
  preauthorizeTelnyxBrandDeletion,
  TelnyxRemoteMutationAuthorizationError,
} from "@/lib/messaging/telnyxDestructive";
import { throwIfCarrierRejected } from "@/lib/onboarding/rejectionGuidance";

// Subset of the Telnyx `Vertical` enum we map to. Sourced from
// node_modules/telnyx/resources/messaging-10dlc/brand/brand.d.ts (line 417).
type TelnyxVertical =
  | "CONSTRUCTION"
  | "FINANCIAL"
  | "HEALTHCARE"
  | "HOSPITALITY"
  | "INSURANCE"
  | "LEGAL"
  | "PROFESSIONAL"
  | "REAL_ESTATE"
  | "RETAIL";

export const LINKED_EXISTING_BRAND_NEEDS_SUPPORT_CODE =
  "linked_brand_needs_support" as const;

export const LINKED_EXISTING_BRAND_NEEDS_SUPPORT_MESSAGE =
  "This existing Telnyx brand cannot be replaced automatically. Contact SimplAssist Support for help.";

/**
 * A manually linked brand is an existing customer asset, so the automatic
 * rejected-brand recovery path must never archive or delete it. Launch turns
 * this stable domain error into a support-required customer outcome.
 */
export class LinkedExistingBrandSupportRequiredError extends Error {
  readonly code = LINKED_EXISTING_BRAND_NEEDS_SUPPORT_CODE;
  readonly retryable = false;
  readonly businessId: string;

  constructor(businessId: string) {
    super(LINKED_EXISTING_BRAND_NEEDS_SUPPORT_MESSAGE);
    this.name = "LinkedExistingBrandSupportRequiredError";
    this.businessId = businessId;
  }
}

function appBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL is not set — required for Telnyx webhook URLs"
    );
  }
  return url.replace(/\/+$/, "");
}

// Maps our business_type domain to Telnyx's Vertical enum. Carriers (especially
// T-Mobile) check brand vertical against the business's industry — a misaligned
// vertical can trigger MNO review friction even on otherwise-valid brands.
// Any unmapped value falls through to PROFESSIONAL as a safe generic.
function toTelnyxVertical(businessType: BusinessType): TelnyxVertical {
  switch (businessType) {
    case "plumber":
    case "hvac":
      return "CONSTRUCTION";
    case "dentist":
      return "HEALTHCARE";
    case "restaurant":
      return "HOSPITALITY";
    case "real_estate":
      return "REAL_ESTATE";
    case "legal":
      return "LEGAL";
    case "financial":
      return "FINANCIAL";
    case "insurance":
      return "INSURANCE";
    case "retail":
      return "RETAIL";
    case "car_wash":
    case "salon":
    case "auto_shop":
    case "general":
    case "other":
      return "PROFESSIONAL";
  }
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { firstName: trimmed, lastName: "" };
  return {
    firstName: trimmed.slice(0, idx),
    lastName: trimmed.slice(idx + 1).trim(),
  };
}

function toE164(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

/**
 * Dormant staff-recovery primitive for a carrier-rejected brand. It preserves
 * the rejected brand's ID and details in rejected_brands, archives the child
 * campaign, deletes the brand at Telnyx best-effort, and clears the local
 * pointer so an explicitly authorized workflow could create a replacement.
 * Customer launch/retry paths must never call this helper.
 * The messaging profile and voice application are untouched — neither
 * references the brand.
 * A typed safety-boundary denial aborts recovery and preserves local provider
 * pointers; it is never downgraded to a best-effort provider failure.
 *
 * No-op unless brand_status is 'rejected' with a brand ID present. Safe to
 * re-run after a partial staff operation: the history row is reused, the
 * campaign cascade no-ops once its pointer is cleared, and an already-deleted
 * brand is not re-deleted.
 */
export async function archiveAndClearRejectedBrand(
  businessId: string
): Promise<void> {
  const { data: business, error: readError } = await supabaseAdmin
    .from("businesses")
    .select(
      "id, telnyx_brand_id, telnyx_brand_source, brand_status, brand_rejection_reason"
    )
    .eq("id", businessId)
    .single<{
      id: string;
      telnyx_brand_id: string | null;
      telnyx_brand_source: TelnyxBrandSource | null;
      brand_status: string | null;
      brand_rejection_reason: string | null;
    }>();

  if (readError || !business) {
    throw new Error(
      `[registration:brand] Business ${businessId} not found for rejected-brand recovery: ${readError?.message}`
    );
  }

  if (!business.telnyx_brand_id || business.brand_status !== "rejected") {
    return;
  }

  // A linked brand existed before SimplAssist attached it. Treat a rejection
  // as a support case: do not archive its local history, touch its campaign,
  // delete it at Telnyx, or clear the business pointer automatically.
  if (business.telnyx_brand_source === "linked_existing") {
    throw new LinkedExistingBrandSupportRequiredError(businessId);
  }

  const brandId = business.telnyx_brand_id;

  // 1. Preserve history before anything is repointed (reuse the row if a
  //    prior partial run already archived this brand).
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("rejected_brands")
    .select("id, telnyx_deleted")
    .eq("business_id", businessId)
    .eq("telnyx_brand_id", brandId)
    .maybeSingle<{ id: string; telnyx_deleted: boolean }>();

  if (existingError) {
    // Fail loudly rather than risk duplicating history or re-deleting:
    // the thrown error keeps the attempt in a retryable state.
    throw new Error(
      `[registration:brand] Failed to read rejected-brand history for ${businessId}: ${existingError.message}`
    );
  }

  let historyId = existing?.id ?? null;
  if (!historyId) {
    const { data: inserted, error: historyError } = await supabaseAdmin
      .from("rejected_brands")
      .insert({
        business_id: businessId,
        telnyx_brand_id: brandId,
        rejection_reason: business.brand_rejection_reason,
      })
      .select("id")
      .single<{ id: string }>();

    if (historyError || !inserted) {
      throw new Error(
        `[registration:brand] Failed to archive rejected brand ${brandId} for ${businessId}: ${historyError?.message}`
      );
    }
    historyId = inserted.id;
  }

  // Authorize the brand deletion BEFORE touching its child campaign. The
  // actual delete authorizes again so a protection/configuration change made
  // during the campaign operation still fails closed.
  if (!existing?.telnyx_deleted) {
    await preauthorizeTelnyxBrandDeletion({
      businessId,
      context: "rejection_recovery",
      providerId: brandId,
    });
  }

  // 2. Archive the child campaign BEFORE the Telnyx brand delete: Telnyx
  //    refuses to delete a brand that still has active campaigns. Runs
  //    while brand_status is still 'rejected', so a failure here leaves
  //    this helper re-runnable.
  await archiveAndClearRejectedCampaign(businessId, { cause: "brand_refile" });

  // 3. Best-effort Telnyx brand deletion (there is no brand deactivate API).
  //    Provider failures do not block the retry; a typed safety-boundary
  //    denial does.
  if (!existing?.telnyx_deleted) {
    try {
      await deleteTelnyxBrand({
        businessId,
        context: "rejection_recovery",
        providerId: brandId,
      });
      await supabaseAdmin
        .from("rejected_brands")
        .update({ telnyx_deleted: true, deletion_error: null })
        .eq("id", historyId);
    } catch (err) {
      if (err instanceof TelnyxRemoteMutationAuthorizationError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[registration:brand] Best-effort deletion of rejected brand ${brandId} failed for ${businessId} — needs manual cleanup:`,
        err
      );
      await supabaseAdmin
        .from("rejected_brands")
        .update({ deletion_error: message })
        .eq("id", historyId);
    }
  }

  // 4. Clear the pointer so registerBrand creates the replacement.
  const { error: clearError } = await supabaseAdmin
    .from("businesses")
    .update({
      telnyx_brand_id: null,
      brand_status: null,
      brand_status_updated_at: new Date().toISOString(),
      brand_rejection_reason: null,
    })
    .eq("id", businessId);

  if (clearError) {
    throw new Error(
      `[registration:brand] Failed to clear rejected brand ${brandId} for ${businessId}: ${clearError.message}`
    );
  }
}

export async function registerBrand(businessId: string, options?: { beforePaidSubmit: () => Promise<void> }): Promise<void> {
  const { data: business, error: readError } = await supabaseAdmin
    .from("businesses")
    .select(
      "id, name, slug, legal_business_name, business_entity_type, business_type, has_ein, ein, compliance_info_completed_at, telnyx_brand_id, authorized_rep_name, authorized_rep_email, authorized_rep_phone, address, city, state, zip, website_url, brand_status, campaign_status, brand_rejection_reason, campaign_rejection_reason"
    )
    .eq("id", businessId)
    .single();

  if (readError || !business) {
    throw new Error(
      `[registration:brand] Business ${businessId} not found: ${readError?.message}`
    );
  }

  // Existing provider IDs used to return before the create-boundary refresh.
  // Check the same fresh row first so a retry claimed from a webhook's
  // `failed` state cannot silently reuse a rejected resource.
  throwIfCarrierRejected({
    brandStatus: business.brand_status,
    campaignStatus: business.campaign_status,
    brandReason: business.brand_rejection_reason,
    campaignReason: business.campaign_rejection_reason,
  });

  if (business.telnyx_brand_id) {
    return;
  }

  if (!business.compliance_info_completed_at) {
    throw new Error(
      `[registration:brand] Business ${businessId} has not completed compliance info`
    );
  }

  if (!business.business_entity_type) {
    throw new Error(
      `[registration:brand] Business ${businessId} is missing business_entity_type`
    );
  }

  if (!business.legal_business_name) {
    throw new Error(
      `[registration:brand] Business ${businessId} is missing legal_business_name`
    );
  }

  if (business.has_ein !== true) {
    throw new Error(
      `[registration:brand] Business ${businessId} has not confirmed EIN status`
    );
  }

  if (!business.ein) {
    throw new Error(
      `[registration:brand] Business ${businessId} is missing EIN (Phase 11 will add Sole Prop path)`
    );
  }

  if (!business.authorized_rep_email) {
    throw new Error(
      `[registration:brand] Business ${businessId} is missing authorized_rep_email`
    );
  }

  const entityType = toTelnyxEntityType(business.business_entity_type);
  const vertical = toTelnyxVertical(business.business_type);
  const { firstName, lastName } = splitName(business.authorized_rep_name ?? "");
  const phone = toE164(business.authorized_rep_phone);
  const einDigits = business.ein.replace(/\D/g, "");
  const webhookURL = `${appBaseUrl()}/api/messaging/registration/status`;
  const stateCode = normalizeUsStateCode(business.state);

  if (!firstName || !lastName) {
    throw new Error(
      `[registration:brand] Business ${businessId} authorized_rep_name must include first and last name`
    );
  }

  if (!stateCode) {
    throw new Error(
      `[registration:brand] Business ${businessId} address state must be a valid 2-letter US state code`
    );
  }

  // Phase 6: customers without a website_url still need a brand `website`
  // value on Telnyx submission — submitting null/undefined delays MNO review.
  // Fall back to the hosted business landing page at /c/[slug] in that case.
  // buildBusinessLandingUrl throws on a 'pending-*' placeholder slug; the
  // brand-verification pre-flight gate is the primary safety net for that.
  const trimmedWebsite = business.website_url?.trim();
  const resolvedWebsite =
    trimmedWebsite && trimmedWebsite.length > 0
      ? trimmedWebsite
      : buildBusinessLandingUrl(business.slug);

  try {
    // Re-read carrier state at the charged mutation boundary. A rejection
    // webhook can land after paid launch's initial read; never let that stale
    // snapshot create another paid brand.
    await assertNoCarrierRejectionBeforeBrandCreate(businessId);
    await options?.beforePaidSubmit();

    const response = await telnyx.messaging10dlc.brand.create(
      {
        country: "US",
        displayName: business.name,
        companyName: business.legal_business_name,
        email: business.authorized_rep_email,
        entityType,
        vertical,
        // ISV/SaaS flag — corresponds to the Telnyx dashboard checkbox
        // "Yes, I am creating a brand on behalf of another organization".
        // SimplAssist is always the registering ISV when this code path runs;
        // each customer brand belongs to a separate end-business (Mike's Roofing,
        // etc.), so the flag is unconditionally true.
        isReseller: true,
        ein: einDigits,
        firstName,
        lastName,
        phone,
        street: business.address ?? undefined,
        city: business.city ?? undefined,
        state: stateCode,
        postalCode: business.zip ?? undefined,
        website: resolvedWebsite,
        webhookURL,
        webhookFailoverURL: webhookURL,
      },
      // This POST can incur real Telnyx/TCR charges. Do not let the SDK
      // replay an ambiguous success; provider reconciliation remains parked.
      { maxRetries: 0 },
    );

    const brandId = response.brandId;
    if (!brandId) {
      throw new Error(
        `[registration:brand] Telnyx returned no brandId for business ${businessId}`
      );
    }

    const { error: updateError } = await supabaseAdmin
      .from("businesses")
      .update({
        telnyx_brand_id: brandId,
        brand_status: "pending",
        brand_status_updated_at: new Date().toISOString(),
      })
      .eq("id", businessId);

    if (updateError) {
      throw new Error(
        `[registration:brand] Failed to persist brand id ${brandId} for business ${businessId}: ${updateError.message}`
      );
    }

    await appendRegistrationEvent({
      businessId,
      eventType: "brand_submitted",
      resourceType: "brand",
      resourceId: brandId,
      status: "pending",
      rawPayload: {
        ...(response as unknown as Record<string, unknown>),
        _submitted: { website: resolvedWebsite },
      },
    });
  } catch (err) {
    await appendRegistrationEvent({
      businessId,
      eventType: "brand_submitted",
      resourceType: "brand",
      status: "error",
      rawPayload: {
        error: serializeError(err),
        _submitted: { website: resolvedWebsite },
      },
    });
    throw err;
  }
}

async function assertNoCarrierRejectionBeforeBrandCreate(
  businessId: string
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "brand_status, campaign_status, brand_rejection_reason, campaign_rejection_reason"
    )
    .eq("id", businessId)
    .single<{
      brand_status: string | null;
      campaign_status: string | null;
      brand_rejection_reason: string | null;
      campaign_rejection_reason: string | null;
    }>();

  if (error || !data) {
    throw new Error(
      `[registration:brand] Failed to refresh carrier status before brand creation for ${businessId}: ${error?.message ?? "business not found"}`
    );
  }

  throwIfCarrierRejected({
    brandStatus: data.brand_status,
    campaignStatus: data.campaign_status,
    brandReason: data.brand_rejection_reason,
    campaignReason: data.campaign_rejection_reason,
  });
}
