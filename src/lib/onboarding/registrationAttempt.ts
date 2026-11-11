import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";
import type { OnboardingRegistrationStatus } from "@/types/database";

const STALE_SUBMITTING_AFTER_MS = 15 * 60 * 1000;

export interface AttemptRow {
  id: string;
  onboarding_registration_status: OnboardingRegistrationStatus;
  onboarding_registration_started_at: string | null;
  onboarding_registration_submitted_at: string | null;
  onboarding_registration_error: string | null;
  telnyx_brand_id?: string | null;
  telnyx_campaign_id?: string | null;
  brand_status?: string | null;
}

export type RegistrationClaimOrigin =
  | "not_started"
  | "failed"
  | "pending_brand"
  | "stale_submitting";

export type RegistrationAttemptClaim =
  | {
      claimed: true;
      startedAt: string;
      /**
       * The registration status the claim transitioned FROM, captured
       * atomically (compare-and-swap). Callers use this to re-run
       * retry-only gates (risk re-screen) against live state instead of a
       * possibly-stale pre-claim snapshot.
       */
      claimedFrom: RegistrationClaimOrigin;
    }
  | {
      claimed: false;
      reason: "already_submitted" | "already_submitting" | "not_claimable";
      current: AttemptRow | null;
    };

export type RegistrationAttemptCompletion =
  | { completed: true }
  | { completed: false; current: AttemptRow | null };

export async function claimRegistrationAttempt(
  businessId: string
): Promise<RegistrationAttemptClaim> {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_SUBMITTING_AFTER_MS).toISOString();

  // Read the current state, then claim via compare-and-swap on exactly the
  // observed state. A concurrent transition (webhook, another attempt)
  // between read and update makes the CAS match zero rows — never a claim
  // from a state we didn't observe.
  const observed = await readRegistrationAttempt(businessId);
  const observedStatus = observed?.onboarding_registration_status ?? null;
  const observedStartedAt = observed?.onboarding_registration_started_at ?? null;

  let origin: RegistrationClaimOrigin | null = null;
  if (observedStatus === "not_started") {
    origin = "not_started";
  } else if (observedStatus === "failed") {
    origin = "failed";
  } else if (observedStatus === "submitted" && observed?.telnyx_brand_id &&
    !observed.telnyx_campaign_id && observed.brand_status === "approved" &&
    !observed.onboarding_registration_error) {
    origin = "pending_brand";
  } else if (
    observedStatus === "submitting" &&
    (observedStartedAt === null || observedStartedAt < staleBefore)
  ) {
    origin = "stale_submitting";
  }

  if (origin === null) {
    if (observedStatus === "submitted") {
      return { claimed: false, reason: "already_submitted", current: observed };
    }
    if (observedStatus === "submitting") {
      return { claimed: false, reason: "already_submitting", current: observed };
    }
    return { claimed: false, reason: "not_claimable", current: observed };
  }

  let query = supabaseAdmin
    .from("businesses")
    .update({
      onboarding_registration_status: "submitting",
      onboarding_registration_started_at: now,
      onboarding_registration_error: null,
    })
    .eq("id", businessId)
    .eq("onboarding_registration_status", observedStatus);

  if (origin === "stale_submitting") {
    query =
      observedStartedAt === null
        ? query.is("onboarding_registration_started_at", null)
        : query.eq("onboarding_registration_started_at", observedStartedAt);
  }

  if (origin === "pending_brand") {
    query = query.eq("telnyx_brand_id", observed!.telnyx_brand_id!)
      .is("telnyx_campaign_id", null).eq("brand_status", "approved")
      .is("onboarding_registration_error", null);
  }

  const { data, error } = await query
    .select(
      "id, onboarding_registration_status, onboarding_registration_started_at, onboarding_registration_submitted_at, onboarding_registration_error"
    )
    .returns<AttemptRow[]>();

  if (error) {
    throw new Error(
      `[onboarding:registrationAttempt] Failed to claim registration for ${businessId}: ${error.message}`
    );
  }

  if (data && data.length > 0) {
    return { claimed: true, startedAt: now, claimedFrom: origin };
  }

  // CAS missed: someone else transitioned the row between read and update.
  const current = await readRegistrationAttempt(businessId);
  if (current?.onboarding_registration_status === "submitted") {
    return { claimed: false, reason: "already_submitted", current };
  }
  if (current?.onboarding_registration_status === "submitting") {
    return { claimed: false, reason: "already_submitting", current };
  }

  return { claimed: false, reason: "not_claimable", current };
}

export async function markRegistrationSubmitted(
  businessId: string,
  startedAt: string,
): Promise<RegistrationAttemptCompletion> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .update({
      onboarding_registration_status: "submitted",
      onboarding_registration_submitted_at: now,
      onboarding_registration_error: null,
      onboarding_step: "carrier_review",
      onboarding_last_saved_at: now,
    })
    .eq("id", businessId)
    // Only complete the claimed attempt: if a rejection webhook landed
    // mid-pipeline and set status to 'failed', don't clobber it back to
    // 'submitted' (that would strand the business with no Retry offered).
    .eq("onboarding_registration_status", "submitting")
    // Bind completion to this launch's exact claim. A stale worker must not
    // complete a newer attempt that reclaimed the same business row.
    .eq("onboarding_registration_started_at", startedAt)
    .select(
      "id, onboarding_registration_status, onboarding_registration_started_at, onboarding_registration_submitted_at, onboarding_registration_error",
    )
    .maybeSingle<AttemptRow>();

  if (error) {
    throw new Error(
      `[onboarding:registrationAttempt] Failed to mark registration submitted for ${businessId}: ${error.message}`
    );
  }

  if (data) return { completed: true };

  return {
    completed: false,
    current: await readRegistrationAttempt(businessId),
  };
}

export async function markRegistrationFailed(
  businessId: string,
  message: string
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("businesses")
    .update({
      onboarding_registration_status: "failed",
      onboarding_registration_error: message,
      onboarding_registration_submitted_at: null,
      onboarding_step: "carrier_review",
      onboarding_last_saved_at: now,
    })
    .eq("id", businessId);

  if (error) {
    throw new Error(
      `[onboarding:registrationAttempt] Failed to mark registration failed for ${businessId}: ${error.message}`
    );
  }
}

async function readRegistrationAttempt(
  businessId: string
): Promise<AttemptRow | null> {
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "id, onboarding_registration_status, onboarding_registration_started_at, onboarding_registration_submitted_at, onboarding_registration_error, telnyx_brand_id, telnyx_campaign_id, brand_status"
    )
    .eq("id", businessId)
    .maybeSingle<AttemptRow>();

  if (error) {
    throw new Error(
      `[onboarding:registrationAttempt] Failed to read registration attempt for ${businessId}: ${error.message}`
    );
  }

  return data ?? null;
}
