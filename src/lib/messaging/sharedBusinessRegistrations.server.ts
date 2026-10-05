import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import {
  compareExistingBrandIdentity,
  normalizeEinDigits,
  normalizeTelnyxEntityType,
  type ExistingBrandLocalIdentity,
  type ExistingBrandProviderIdentity,
} from "./registration/identity";
import { sharedBrandObservedStatus } from "./sharedBrandEvents.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_BUSINESS = "ea848911-ef72-44a6-8cf3-c47b3959be26";
const DELETED_BUSINESS = "aa30a10e-13c1-4c9b-b9d5-6804cf01e6cb";
const CAMPAIGN_CAP = 5;

export class SharedRegistrationError extends Error {
  constructor(public readonly code: string, public readonly status = 409) {
    super(code);
    this.name = "SharedRegistrationError";
  }
}

export interface SharedRegistrationProof {
  registrationId: string;
  identityVersion: number;
  membershipRevision: number;
  brandId: string;
}
interface LegalIdentity extends ExistingBrandLocalIdentity {
  address: string;
  city: string;
  business_registration_state: string;
}
interface RegistrationRow {
  id: string;
  legal_identity: LegalIdentity;
  identity_version: number;
  telnyx_brand_id: string;
  tcr_brand_id: string;
  status: "active" | "support_required";
  brand_status: "approved" | "pending" | "rejected";
  provider_verified_at: string;
}
interface MembershipRow {
  business_id: string;
  registration_id: string;
  owner_id: string;
  identity_version: number;
  revision: number;
  state: "approved" | "active" | "revoked";
}
export interface SharedRegistrationContext {
  registration: RegistrationRow & { brand_id: string; legal_business_name: string };
  membership: MembershipRow & { status: MembershipRow["state"] };
}
interface BusinessIdentity extends LegalIdentity {
  id: string;
  owner_id: string;
  name: string;
  has_ein: boolean;
  shared_registration_id: string | null;
  telnyx_brand_id: string | null;
  deleted_at: string | null;
  operations_suspended_at: string | null;
  telnyx_submission_disabled: boolean;
}
interface ProviderBrand extends ExistingBrandProviderIdentity {
  brandId?: string;
  tcrBrandId?: string;
  street?: string;
  city?: string;
  country?: string;
  status?: string;
  identityStatus?: string;
  mock?: boolean;
  assignedCampaignsCount?: number;
}
const BUSINESS_FIELDS = "id,owner_id,name,has_ein,ein,legal_business_name,business_entity_type,business_registration_state,address,city,state,zip,shared_registration_id,telnyx_brand_id,deleted_at,operations_suspended_at,telnyx_submission_disabled";

function checked<T>(result: { data: T; error: { message?: string } | null }): T {
  if (result.error) {
    const message = result.error.message ?? "";
    throw new SharedRegistrationError(/^shared_[a-z_]+$/.test(message) ? message : "shared_registration_unavailable", 503);
  }
  return result.data;
}
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return checked(await db.rpc(name, args)) as T;
}
async function businessIdentity(businessId: string): Promise<BusinessIdentity> {
  const row = checked(await db.from("businesses").select(BUSINESS_FIELDS).eq("id", businessId).maybeSingle()) as BusinessIdentity | null;
  if (!row || row.deleted_at || !row.owner_id) throw new SharedRegistrationError("shared_business_unavailable");
  return row;
}

/** Admission flags do not control reads, established service, or recovery. */
export function sharedRegistrationPilotEnabled(businessId: string, kind: "admission" | "paid_start") {
  const values = (process.env.SHARED_REGISTRATION_PILOT_BUSINESS_IDS ?? "").split(",").map(v => v.trim().toLowerCase()).filter(Boolean);
  const ids = new Set(values);
  const enabled = process.env[kind === "admission" ? "SHARED_REGISTRATION_ADMISSIONS_ENABLED" : "SHARED_REGISTRATION_PAID_STARTS_ENABLED"] === "true";
  return enabled && values.every(v => UUID.test(v)) && ids.size === 2
    && ids.has(SOURCE_BUSINESS) && !ids.has(DELETED_BUSINESS) && ids.has(businessId.toLowerCase());
}

export async function readSharedRegistrationContext(businessId: string): Promise<SharedRegistrationContext | null> {
  const member = checked(await db.from("shared_business_registration_members").select("business_id,registration_id,owner_id,identity_version,revision,state").eq("business_id", businessId).maybeSingle()) as MembershipRow | null;
  if (!member) {
    const business = checked(await db.from("businesses").select("shared_registration_id").eq("id", businessId).maybeSingle());
    if (business?.shared_registration_id) throw new SharedRegistrationError("shared_membership_missing");
    return null;
  }
  const registration = checked(await db.from("shared_business_registrations").select("id,legal_identity,identity_version,telnyx_brand_id,tcr_brand_id,status,brand_status,provider_verified_at").eq("id", member.registration_id).single()) as RegistrationRow;
  if (!registration) throw new SharedRegistrationError("shared_registration_unavailable", 503);
  return {
    registration: { ...registration, brand_id: registration.telnyx_brand_id, legal_business_name: registration.legal_identity.legal_business_name ?? "" },
    membership: { ...member, status: member.state },
  };
}

function proofFor(context: SharedRegistrationContext): SharedRegistrationProof {
  return { registrationId: context.registration.id, identityVersion: context.registration.identity_version, membershipRevision: context.membership.revision, brandId: context.registration.telnyx_brand_id };
}
function identityMatches(a: LegalIdentity, b: LegalIdentity) {
  return (["ein", "legal_business_name", "business_entity_type", "business_registration_state", "address", "city", "state", "zip"] as const)
    .every(key => a[key] === b[key]);
}
export async function validateSharedRegistrationProof(args: {
  businessId: string; ownerId: string; proof?: SharedRegistrationProof | null; requireActive?: boolean;
}): Promise<SharedRegistrationContext | null> {
  const context = await readSharedRegistrationContext(args.businessId);
  if (!context) {
    if (args.proof) throw new SharedRegistrationError("shared_membership_missing");
    return null;
  }
  const business = await businessIdentity(args.businessId);
  const { registration: r, membership: m } = context;
  if (m.owner_id !== args.ownerId || business.owner_id !== args.ownerId || business.shared_registration_id !== r.id
    || m.state === "revoked" || (args.requireActive && m.state !== "active")
    || m.identity_version !== r.identity_version || r.status !== "active" || r.brand_status !== "approved"
    || !identityMatches(r.legal_identity, business) || business.operations_suspended_at || business.telnyx_submission_disabled
    || (business.telnyx_brand_id && business.telnyx_brand_id !== r.telnyx_brand_id)) {
    throw new SharedRegistrationError("shared_registration_changed");
  }
  const current = proofFor(context);
  if (args.proof && (Object.keys(current) as Array<keyof SharedRegistrationProof>).some(k => args.proof![k] !== current[k])) {
    throw new SharedRegistrationError("shared_registration_proof_changed");
  }
  return context;
}

async function inspectProvider(brandId: string, identity: LegalIdentity, registration?: RegistrationRow, options: { persistObservation: boolean } = { persistObservation: false }) {
  let provider: ProviderBrand;
  // This is the start of a fresh observation, not the time an earlier carrier
  // callback happened. A slow read must not overtake a newer known status.
  const observedAt = new Date().toISOString();
  try { provider = await telnyx.messaging10dlc.brand.retrieve(brandId, { maxRetries: 0, timeout: 10_000 }) as ProviderBrand; }
  catch { throw new SharedRegistrationError("shared_provider_unavailable", 503); }
  if (!provider || typeof provider !== "object") throw new SharedRegistrationError("shared_provider_response_invalid", 503);
  const providerStatus = sharedBrandObservedStatus(provider as unknown as Record<string, unknown>);
  if (options.persistObservation && registration && provider.brandId === brandId && provider.mock === false &&
    (providerStatus === "rejected" || providerStatus === "pending")) {
    // A definitive loss of approval closes the same gate used by every member.
    // Keep the receipt and fan-out in the existing ordered database transaction.
    await rpc("apply_shared_brand_event", {
      p_brand_id: registration.telnyx_brand_id, p_event_id: `inspection:${registration.id}:${randomUUID()}`,
      p_occurred_at: observedAt, p_status: providerStatus,
      p_rejection_reason: providerStatus === "rejected" ? "Carrier registration is not approved." : null,
    });
  }
  const present = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  const eins = [provider.ein, provider.universalEin].filter(present);
  const completeIdentity = present(provider.brandId) && UUID.test(provider.brandId) && present(provider.tcrBrandId) &&
    typeof provider.mock === "boolean" && present(provider.country) && /^[A-Z]{2}$/.test(provider.country) &&
    eins.length > 0 && eins.every(value => normalizeEinDigits(value) !== null) && present(provider.companyName) &&
    present(provider.entityType) && normalizeTelnyxEntityType(provider.entityType) !== null &&
    [provider.street, provider.city, provider.state, provider.postalCode].every(present);
  const normalizeAddressPart = (v?: string | null) => (v ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  const identityMismatch = completeIdentity && (provider.brandId !== brandId ||
    (registration && provider.tcrBrandId !== registration.tcr_brand_id) || provider.country !== "US" || provider.mock !== false ||
    !compareExistingBrandIdentity(provider, identity).matches || normalizeAddressPart(provider.street) !== normalizeAddressPart(identity.address) ||
    normalizeAddressPart(provider.city) !== normalizeAddressPart(identity.city));
  if (identityMismatch && options.persistObservation && registration) {
    const held = await rpc<boolean>("hold_shared_brand_identity", { p_brand_id: registration.telnyx_brand_id, p_observed_at: observedAt });
    if (held !== true) throw new SharedRegistrationError("shared_registration_identity_hold_failed", 503);
  }
  if (!completeIdentity || identityMismatch || provider.status !== "OK" || providerStatus !== "approved") {
    throw new SharedRegistrationError("shared_provider_identity_not_verified");
  }
  const count = provider.assignedCampaignsCount;
  if (!Number.isInteger(count) || count! < 0) throw new SharedRegistrationError("shared_provider_response_invalid", 503);
  return { provider, campaignCount: count!, verifiedAt: observedAt };
}

async function inspectCampaignCapacity(context: SharedRegistrationContext, campaignCount: number) {
  const ids = new Set<string>();
  try {
    for await (const campaign of telnyx.messaging10dlc.campaign.list({ brandId: context.registration.telnyx_brand_id })) {
      if (campaign.brandId !== context.registration.telnyx_brand_id || !campaign.campaignId) throw new Error("Invalid campaign");
      ids.add(campaign.campaignId);
    }
  } catch { throw new SharedRegistrationError("shared_provider_inventory_unavailable", 503); }
  if (ids.size !== campaignCount) throw new SharedRegistrationError("shared_provider_inventory_changed");
  const reservations = checked(await db.from("shared_brand_campaign_reservations").select("provider_campaign_id").eq("registration_id", context.registration.id)) as Array<{ provider_campaign_id: string | null }>;
  const occupied = new Set(ids);
  let unresolved = 0;
  for (const reservation of reservations) {
    if (reservation.provider_campaign_id) occupied.add(reservation.provider_campaign_id);
    else unresolved++;
  }
  return { ids: Array.from(ids).sort(), occupied: occupied.size + unresolved };
}

export async function assertSharedRegistrationForNewStart(args: {
  businessId: string; ownerId: string; proof?: SharedRegistrationProof | null;
}): Promise<SharedRegistrationProof | null> {
  const context = await validateSharedRegistrationProof(args);
  if (!context) return null;
  if (!sharedRegistrationPilotEnabled(args.businessId, "paid_start")) throw new SharedRegistrationError("shared_paid_starts_disabled");
  const { registration } = context;
  const inspection = await inspectProvider(registration.telnyx_brand_id, registration.legal_identity, registration, { persistObservation: true });
  const capacity = await inspectCampaignCapacity(context, inspection.campaignCount);
  if (capacity.occupied >= CAMPAIGN_CAP) throw new SharedRegistrationError("shared_campaign_capacity_exhausted");
  return proofFor(context);
}

export async function consumeSharedReviewRegistration(args: {
  businessId: string; ownerId: string; reviewAccountId: string; claimToken: string; proof: SharedRegistrationProof;
}): Promise<void> {
  const context = await validateSharedRegistrationProof(args);
  if (!context) throw new SharedRegistrationError("shared_membership_missing");
  await inspectProvider(context.registration.telnyx_brand_id, context.registration.legal_identity, context.registration, { persistObservation: true });
  const bound = await rpc<boolean>("consume_shared_review_brand_member", {
    p_business: args.businessId, p_owner: args.ownerId, p_review_account: args.reviewAccountId, p_claim: args.claimToken,
    p_expected_registration: args.proof.registrationId, p_expected_version: args.proof.identityVersion,
    p_expected_membership_revision: args.proof.membershipRevision,
  });
  if (!bound) throw new SharedRegistrationError("shared_registration_not_bound");
}

interface ReservationRow {
  id: string; business_id: string; operation_id: string; reference_id: string; payload_hash: string;
  provider_campaign_id: string | null;
}
export async function readSharedCampaignReservation(businessId: string, operationId: string) {
  const r = checked(await db.from("shared_brand_campaign_reservations").select("id,business_id,operation_id,reference_id,payload_hash,provider_campaign_id").eq("business_id", businessId).eq("operation_id", operationId).maybeSingle()) as ReservationRow | null;
  return r ? { id: r.id, payloadHash: r.payload_hash, referenceId: r.reference_id, providerCampaignId: r.provider_campaign_id } : null;
}
export async function reserveSharedCampaignSubmission(args: {
  businessId: string; operationId: string; referenceId: string; purpose: "review_initial" | "review_upgrade";
  payloadHash: string; claimToken: string;
}): Promise<{ id: string; submit: boolean; providerCampaignId: string | null } | null> {
  const context = await readSharedRegistrationContext(args.businessId);
  if (!context) return null;
  await validateSharedRegistrationProof({ businessId: args.businessId, ownerId: context.membership.owner_id, proof: proofFor(context), requireActive: true });
  const inspection = await inspectProvider(context.registration.telnyx_brand_id, context.registration.legal_identity, context.registration, { persistObservation: true });
  const capacity = await inspectCampaignCapacity(context, inspection.campaignCount);
  const r = await rpc<{ id: string; submit: boolean; provider_campaign_id: string | null }>("reserve_shared_brand_campaign", {
    p_business: args.businessId, p_purpose: args.purpose, p_operation_id: args.operationId, p_reference_id: args.referenceId,
    p_payload_hash: args.payloadHash, p_observed_campaign_ids: capacity.ids, p_provider_verified_at: inspection.verifiedAt,
    p_claim: args.claimToken, p_expected_membership_revision: context.membership.revision,
  });
  return { id: r.id, submit: r.submit, providerCampaignId: r.provider_campaign_id };
}
export async function settleSharedCampaignSubmission(args: {
  businessId: string; reservationId: string; payloadHash: string;
  outcome: "accepted" | "uncertain" | "not_submitted"; providerCampaignId?: string | null;
}): Promise<void> {
  if (args.outcome === "accepted") {
    const context = await readSharedRegistrationContext(args.businessId);
    const reservation = checked(await db.from("shared_brand_campaign_reservations").select("reference_id").eq("id", args.reservationId).eq("business_id", args.businessId).single());
    if (!context || !args.providerCampaignId || !reservation) throw new SharedRegistrationError("shared_campaign_evidence_missing");
    let campaign;
    try { campaign = await telnyx.messaging10dlc.campaign.retrieve(args.providerCampaignId); }
    catch { throw new SharedRegistrationError("shared_campaign_evidence_unavailable", 503); }
    if (campaign.brandId !== context.registration.telnyx_brand_id || campaign.referenceId !== reservation.reference_id || campaign.campaignId !== args.providerCampaignId) {
      throw new SharedRegistrationError("shared_campaign_evidence_mismatch");
    }
  }
  await rpc("record_shared_brand_campaign", {
    p_business: args.businessId, p_reservation: args.reservationId, p_payload_hash: args.payloadHash,
    p_provider_campaign_id: args.providerCampaignId ?? null, p_outcome: args.outcome === "accepted" ? "bound" : "unknown",
  });
}

export interface SharedRegistrationInspectionInput {
  sourceBusinessId: string; targetBusinessId: string; sourceOwnerId: string; targetOwnerId: string;
}
async function inspectPrivate(args: SharedRegistrationInspectionInput) {
  if (args.sourceBusinessId !== SOURCE_BUSINESS || args.targetBusinessId === DELETED_BUSINESS || args.sourceBusinessId === args.targetBusinessId) {
    throw new SharedRegistrationError("shared_pilot_account_invalid");
  }
  const [source, target, existing] = await Promise.all([
    businessIdentity(args.sourceBusinessId), businessIdentity(args.targetBusinessId), readSharedRegistrationContext(args.targetBusinessId),
  ]);
  if (source.owner_id !== args.sourceOwnerId || target.owner_id !== args.targetOwnerId || !source.telnyx_brand_id || !source.has_ein) {
    throw new SharedRegistrationError("shared_business_owner_changed");
  }
  const canonical = source.shared_registration_id ? await readSharedRegistrationContext(source.id) : null;
  const inspection = await inspectProvider(source.telnyx_brand_id, source, canonical?.registration);
  return { source, target, existing, ...inspection };
}
export async function inspectSharedRegistration(args: SharedRegistrationInspectionInput) {
  const { source, target, existing, provider, campaignCount, verifiedAt } = await inspectPrivate(args);
  return {
    sourceBusinessId: source.id, targetBusinessId: target.id, targetBusinessName: target.name,
    legalBusinessName: source.legal_business_name, tcrBrandId: provider.tcrBrandId,
    campaignCount, verifiedAt, membershipRevision: existing?.membership.revision ?? 0,
    canApprove: campaignCount < CAMPAIGN_CAP && sharedRegistrationPilotEnabled(target.id, "admission"),
  };
}
export async function approveSharedRegistration(args: SharedRegistrationInspectionInput & { actorId: string; expectedRevision: number }) {
  if (!sharedRegistrationPilotEnabled(args.sourceBusinessId, "admission") || !sharedRegistrationPilotEnabled(args.targetBusinessId, "admission")) {
    throw new SharedRegistrationError("shared_admissions_disabled");
  }
  const { source, existing, provider, campaignCount, verifiedAt } = await inspectPrivate(args);
  if ((existing?.membership.revision ?? 0) !== args.expectedRevision) throw new SharedRegistrationError("shared_membership_revision_changed");
  if (campaignCount >= CAMPAIGN_CAP) throw new SharedRegistrationError("shared_campaign_capacity_exhausted");
  const identity: LegalIdentity = {
    ein: source.ein, legal_business_name: source.legal_business_name, business_entity_type: source.business_entity_type,
    business_registration_state: source.business_registration_state, address: source.address, city: source.city, state: source.state, zip: source.zip,
  };
  await rpc<string>("approve_shared_review_brand_member", {
    p_source_business: args.sourceBusinessId, p_target_business: args.targetBusinessId, p_actor: args.actorId,
    p_expected_source_owner: args.sourceOwnerId, p_expected_target_owner: args.targetOwnerId, p_expected_revision: args.expectedRevision,
    p_expected_brand_id: source.telnyx_brand_id, p_expected_tcr_brand_id: provider.tcrBrandId,
    p_provider_identity: identity, p_provider_verified_at: verifiedAt,
  });
  return inspectSharedRegistration(args);
}
export async function revokeSharedRegistration(args: { businessId: string; ownerId: string; actorId: string; expectedRevision: number; reason: string }) {
  await rpc("revoke_shared_review_brand_member", {
    p_business: args.businessId, p_actor: args.actorId, p_expected_owner: args.ownerId, p_expected_revision: args.expectedRevision, p_reason: args.reason,
  });
}
