import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { isReviewTextingUpgradeEnabled } from "./textingUpgradeRollout.server";
import { TextingUpgradeError } from "./textingUpgrade";
import { buildCustomerCareTemplateCopy } from "@/lib/messaging/registration/customerCareTemplates";
import { reviewSignupDescription, reviewSignupSamples } from "@/lib/messaging/registration/reviewSignup";
import { buildCampaignMessageFlow } from "@/lib/messaging/registration/campaignMessageFlow";
import { resolveLegalUrls } from "@/lib/messaging/registration/legalUrls";
import { mapBrandStatus, mapCampaignStatus } from "@/lib/messaging/registration/statusMapper";
import { getA2pRiskClearanceForBusiness } from "@/lib/messaging/registration/riskScreening";
import { inspectReviewSmsKeywords, keywordProgramFromCampaign, reviewSmsKeywordProgram } from "@/lib/reviews/smsKeywords.server";
import { reviewConsentUrl, reviewConsentConfirmation } from "@/lib/reviews/consentCopy";
import { reviewOrigin } from "@/lib/reviews/domain";
import { processReviewTextConsent } from "@/lib/reviews/consent.server";
import { retireReviewUpgradeCampaign } from "@/lib/messaging/telnyxDestructive";
import { isReviewSmsEnabled } from "./reviewSmsRollout.server";
import type { Business } from "@/types/database";
import type { CampaignBuilderSubmitParams } from "telnyx/resources/messaging-10dlc/campaign-builder/campaign-builder";

const options = { maxRetries: 0, timeout: 10_000 };
export type ReviewProviderStage = "not_started" | "prepared" | "submitting" | "carrier_pending" | "approved" | "moving" | "review_ready" | "support_required";
interface ProviderRow {
  upgrade_id: string; business_id: string; owner_id: string; review_account_id: string;
  stage: Exclude<ReviewProviderStage,"not_started">; source_campaign_id: string; candidate_campaign_id: string | null;
  brand_id: string; messaging_profile_id: string; phone_number: string; phone_number_id: string;
  filing: CampaignBuilderSubmitParams; filing_hash: string; submission_attempted_at: string | null;
  assignment_attempted_at: string | null; handoff_requested_at: string | null; handoff_completed_at: string | null;
  retirement_state: "pending" | "submitting" | "unknown" | "done"; last_error: string | null;
}
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await db.rpc(name, args);
  if (r.error) throw new TextingUpgradeError(/review_upgrade_[a-z_]+/.exec(r.error.message)?.[0] ?? "review_upgrade_unavailable", 409);
  return r.data as T;
}
function forbiddenProfiles() {
  const ids = [process.env.TELNYX_PROTECTED_MESSAGING_PROFILE_ID, process.env.TELNYX_MESSAGING_PROFILE_ID].filter((id): id is string => Boolean(id?.trim()));
  if (!ids.length) throw new TextingUpgradeError("review_upgrade_protection_unconfigured", 503);
  return ids;
}
async function context(businessId: string, ownerId: string) {
  const [business, upgrade] = await Promise.all([
    db.from("businesses").select("*").eq("id",businessId).eq("owner_id",ownerId).is("deleted_at",null).maybeSingle(),
    db.from("chat_texting_upgrades").select("*").eq("business_id",businessId).eq("owner_id",ownerId).eq("source_mode","review_sms").neq("state","abandoned").maybeSingle(),
  ]);
  if (business.error || upgrade.error) throw new TextingUpgradeError("review_upgrade_unavailable",503);
  if (!business.data || !upgrade.data) throw new TextingUpgradeError("review_upgrade_not_selected",409);
  const account = await db.from("review_sms_accounts").select("*").eq("id",upgrade.data.source_review_account_id).eq("business_id",businessId).maybeSingle();
  if (account.error || !account.data) throw new TextingUpgradeError("review_upgrade_source_changed",409);
  const phone = await db.from("phone_numbers").select("phone_number").eq("id",account.data.phone_number_id).eq("business_id",businessId).eq("is_active",true).maybeSingle();
  if (phone.error || !phone.data) throw new TextingUpgradeError("review_upgrade_source_changed",409);
  return {business:business.data as Business, upgrade:upgrade.data, account:account.data, phone:phone.data.phone_number};
}
async function readRow(id: string) {
  const r = await db.from("review_texting_provider_upgrades").select("*").eq("upgrade_id",id).maybeSingle();
  if (r.error) throw new TextingUpgradeError("review_upgrade_unavailable",503);
  return r.data as ProviderRow | null;
}
export function buildReviewUpgradeFiling(b: Business, upgradeId: string, phone: string): CampaignBuilderSubmitParams {
  if (!b.name?.trim() || !b.business_type || !b.slug || b.slug.startsWith("pending-") || b.slug.startsWith("deleted-") || !b.authorized_rep_email?.trim())
    throw new TextingUpgradeError("review_upgrade_business_details_required");
  // The frozen proposal and the hosted pages are rendered by the same program
  // helpers. An old external privacy URL cannot silently advertise less scope.
  const label = b.name.trim().slice(0,70), links = resolveLegalUrls({...b,privacy_terms_mode:"hosted"}), origin = reviewOrigin();
  const care = buildCustomerCareTemplateCopy({businessName:label,businessType:b.business_type});
  const flow = buildCampaignMessageFlow({business:{name:label,email:b.email,phone_number:b.phone_number},smsPhoneNumber:phone,smsEntryPoint:`${origin}/c/${b.slug}`,privacyUrl:links.privacyUrl,termsUrl:links.termsUrl,reviewConsentPageUrl:reviewConsentUrl(b.slug,origin)});
  const samples = [...care.sampleMessages.slice(0,3),...reviewSignupSamples(label,origin)];
  if (samples.some(sample => sample.length>255)) throw new TextingUpgradeError("review_upgrade_sample_too_long");
  const keywords = reviewSmsKeywordProgram(label,b.authorized_rep_email ?? "");
  return {
    brandId:b.telnyx_brand_id!,usecase:"MIXED",subUsecases:["CUSTOMER_CARE","MARKETING"],
    description:reviewSignupDescription(care.useCaseDescription),messageFlow:flow.messageFlow,
    sample1:samples[0],sample2:samples[1],sample3:samples[2],sample4:samples[3],sample5:samples[4],
    subscriberOptin:true,optinKeywords:"REVIEWS",optinMessage:reviewConsentConfirmation(label),
    subscriberOptout:true,optoutKeywords:keywords.stop.keywords.join(","),optoutMessage:keywords.stop.resp_text,
    subscriberHelp:true,helpKeywords:keywords.info.keywords.join(","),helpMessage:keywords.info.resp_text,
    termsAndConditions:true,privacyPolicyLink:links.privacyUrl,termsAndConditionsLink:links.termsUrl,
    autoRenewal:true,embeddedLink:true,embeddedPhone:false,numberPool:false,directLending:false,ageGated:false,
    referenceId:`upgrade:${upgradeId}`,webhookURL:`${origin}/api/messaging/registration/status`,webhookFailoverURL:`${origin}/api/messaging/registration/status`,
  };
}
export function reviewUpgradeCandidateMatches(candidate: Record<string, unknown> | null | undefined, p: Pick<ProviderRow,"filing"|"brand_id"|"upgrade_id">) {
  if (!candidate || !Array.isArray(candidate.subUsecases) || candidate.subUsecases.some(value=>typeof value!=="string")) return false;
  const filing = p.filing as unknown as Record<string, unknown>;
  const fields = ["brandId","referenceId","usecase","description","messageFlow","sample1","sample2","sample3","sample4","sample5","embeddedLink","optinKeywords","optinMessage","optoutKeywords","optoutMessage","helpKeywords","helpMessage","privacyPolicyLink","termsAndConditionsLink","subscriberOptin","subscriberOptout","subscriberHelp","termsAndConditions","autoRenewal","embeddedPhone","numberPool","directLending","ageGated"];
  return candidate.brandId===p.brand_id && candidate.referenceId===`upgrade:${p.upgrade_id}` && candidate.usecase==="MIXED" && fields.every(key => candidate[key] === filing[key]) &&
    JSON.stringify([...candidate.subUsecases].sort())===JSON.stringify(["CUSTOMER_CARE","MARKETING"].sort());
}
export async function getReviewTextingProviderState(businessId: string, ownerId: string) {
  const c = await context(businessId,ownerId), p = await readRow(c.upgrade.id);
  let filing: CampaignBuilderSubmitParams;
  try {filing=p?.filing ?? buildReviewUpgradeFiling(c.business,c.upgrade.id,c.phone);}
  catch(error) {
    if (!(error instanceof TextingUpgradeError) || error.code!=="review_upgrade_business_details_required") throw error;
    return {stage:"not_started",canPrepare:false,canMove:false,paused:false,error:error.code,
      submissionPreview:{description:"",samples:[],messageFlow:"",privacyUrl:"",termsUrl:""}};
  }
  const enabled = isReviewTextingUpgradeEnabled(businessId);
  return {stage:p?.stage ?? "not_started",canPrepare:enabled && !p && c.upgrade.state==="draft",
    canMove:p?.stage==="approved" && c.upgrade.state==="draft",
    paused:Boolean(p?.handoff_requested_at && !p.handoff_completed_at && (p.stage==="moving" || p.assignment_attempted_at)),error:p?.last_error ?? null,
    submissionPreview:{description:filing.description,samples:[filing.sample1,filing.sample2,filing.sample3,filing.sample4,filing.sample5],messageFlow:filing.messageFlow,privacyUrl:filing.privacyPolicyLink,termsUrl:filing.termsAndConditionsLink}};
}
export async function prepareReviewTextingProvider(businessId: string, ownerId: string) {
  if (!isReviewTextingUpgradeEnabled(businessId)) throw new TextingUpgradeError("review_upgrade_disabled");
  const c = await context(businessId,ownerId);
  if (!(await getA2pRiskClearanceForBusiness(businessId)).cleared) throw new TextingUpgradeError("review_upgrade_risk_review_required");
  const old = await telnyx.messaging10dlc.campaign.retrieve(c.business.telnyx_campaign_id!,options);
  if (old.brandId!==c.business.telnyx_brand_id || old.referenceId!==`reviews:${c.account.id}` || old.usecase!=="MARKETING" || mapCampaignStatus(old).dbStatus!=="approved") throw new TextingUpgradeError("review_upgrade_source_campaign_invalid");
  const filing = buildReviewUpgradeFiling(c.business,c.upgrade.id,c.phone);
  if (!(await inspectReviewSmsKeywords(c.business.telnyx_messaging_profile_id!,keywordProgramFromCampaign(filing,c.business.name))).ready) throw new TextingUpgradeError("review_upgrade_keywords_changed");
  await rpc("review_texting_provider_prepare",{p_business:businessId,p_owner:ownerId,p_filing:filing,p_hash:createHash("sha256").update(JSON.stringify(filing)).digest("hex"),p_forbidden_profiles:forbiddenProfiles()});
  await reconcileReviewTextingProvider(c.upgrade.id);
}
export async function moveReviewTextingProvider(businessId: string, ownerId: string) {
  const c = await context(businessId,ownerId);
  await rpc("review_texting_provider_request_move",{p_upgrade:c.upgrade.id,p_owner:ownerId,p_forbidden_profiles:forbiddenProfiles()});
  await reconcileReviewTextingProvider(c.upgrade.id);
}
export async function refreshReviewTextingProvider(businessId: string, ownerId: string) {
  const c=await context(businessId,ownerId);
  await reconcileReviewTextingProvider(c.upgrade.id);
}

/** Retries read/reconcile exact prior outcomes, never a second paid submission. */
export async function reconcileReviewTextingProvider(upgradeId: string) {
  let p=await readRow(upgradeId);
  if (!p) return;
  const claim=await rpc<string|null>("review_texting_provider_claim",{p_upgrade:upgradeId});
  if (!claim) return;
  const record=(event:string,evidence:Record<string,unknown>={})=>rpc<void>("review_texting_provider_record",{p_upgrade:upgradeId,p_claim:claim,p_event:event,p_evidence:evidence});
  // The owner already authorized this exact frozen filing. A disabled rollout
  // stops new preparations, never recovery of a committed provider operation.
  const authorize=(operation:string)=>rpc<boolean>("review_texting_provider_authorize",{p_upgrade:upgradeId,p_claim:claim,p_operation:operation,p_forbidden_profiles:forbiddenProfiles()});
  try {
    if (["prepared","submitting"].includes(p.stage)) {
      const matches=[];
      let count=0;
      for await (const candidate of telnyx.messaging10dlc.campaign.list({brandId:p.brand_id},options)) {
        count++;
        if (candidate.referenceId===`upgrade:${upgradeId}`) matches.push(candidate);
      }
      if (matches.length>1) { await record("support",{reason:"review_upgrade_duplicate_candidate"});return; }
      let candidateId=matches[0]?.campaignId;
      if (!candidateId && !p.submission_attempted_at) {
        if (count>=5) { await record("support",{reason:"review_upgrade_campaign_cap"});return; }
        const brand=await telnyx.messaging10dlc.brand.retrieve(p.brand_id,options);
        if (mapBrandStatus(brand).dbStatus!=="approved") return;
        const qualification=await telnyx.messaging10dlc.campaignBuilder.brand.qualifyByUsecase("MIXED",{brandId:p.brand_id},options);
        if (qualification.usecase!=="MIXED" || (qualification.minSubUsecases ?? 99)>2 || (qualification.maxSubUsecases ?? 0)<2) { await record("support",{reason:"review_upgrade_usecase_unavailable"});return; }
        if (!(await authorize("submit"))) return;
        const submitted=await telnyx.messaging10dlc.campaignBuilder.submit(p.filing,options);
        candidateId=submitted.campaignId;
      }
      if (!candidateId) { if (p.submission_attempted_at) await record("support",{reason:"review_upgrade_submission_unknown"});return; }
      await record("submitted",{campaignId:candidateId});
      p=(await readRow(upgradeId))!;
    }
    if (["carrier_pending","approved","moving"].includes(p.stage)) {
      const campaign=await telnyx.messaging10dlc.campaign.retrieve(p.candidate_campaign_id!,options);
      if (!reviewUpgradeCandidateMatches(campaign as unknown as Record<string,unknown>,p)) { await record("support",{reason:"review_upgrade_campaign_mismatch"});return; }
      const status=mapCampaignStatus(campaign).dbStatus;
      if (status==="rejected") { await record("support",{reason:"review_upgrade_carrier_rejected"});return; }
      if (status!=="approved") return;
      const business=await db.from("businesses").select("name").eq("id",p.business_id).single();
      if (business.error || !business.data) throw new Error("Business unavailable");
      if (!(await inspectReviewSmsKeywords(p.messaging_profile_id,keywordProgramFromCampaign(campaign,business.data.name))).ready) { await record("support",{reason:"review_upgrade_keywords_changed"});return; }
      if (p.stage!=="moving") {
        await record("approved",{campaignId:p.candidate_campaign_id,brandId:p.brand_id,filingHash:p.filing_hash,status:"approved"});
        return;
      }
      const phone=await db.from("phone_numbers").select("telnyx_phone_number_id").eq("id",p.phone_number_id).eq("business_id",p.business_id).single();
      if (phone.error || !phone.data?.telnyx_phone_number_id) throw new Error("Sender unavailable");
      const providerPhone=await telnyx.phoneNumbers.messaging.retrieve(phone.data.telnyx_phone_number_id,options);
      if (providerPhone.data?.phone_number!==p.phone_number || providerPhone.data?.messaging_profile_id!==p.messaging_profile_id) {await record("support",{reason:"review_upgrade_sender_changed"});return;}
      const assignment=await telnyx.messaging10dlc.phoneNumberCampaigns.retrieve(p.phone_number,options);
      const matches=(id:string)=>[assignment.campaignId,assignment.telnyxCampaignId].includes(id) && assignment.phoneNumber===p!.phone_number;
      if (matches(p.candidate_campaign_id!) && assignment.assignmentStatus==="ASSIGNED") {
        await record("bound",{campaignId:p.candidate_campaign_id,phoneNumber:p.phone_number,assignmentStatus:"ASSIGNED"});
        p=(await readRow(upgradeId))!;
      } else if (matches(p.source_campaign_id) && assignment.assignmentStatus==="ASSIGNED" && !p.assignment_attempted_at) {
        if (!(await authorize("move"))) return;
        await telnyx.messaging10dlc.phoneNumberCampaigns.update(p.phone_number,{phoneNumber:p.phone_number,campaignId:p.candidate_campaign_id!},options);
        // Always wait for a fresh retrieve on the next poll, even if PUT says ASSIGNED.
        return;
      } else {
        // A stale read of the old assignment is not proof that an accepted PUT
        // will never take effect. Keep the fence until new ASSIGNED or support.
        if (["FAILED_ASSIGNMENT","FAILED_UNASSIGNMENT"].includes(assignment.assignmentStatus ?? "")) await record("support",{reason:"review_upgrade_assignment_failed"});
        return;
      }
    }
    if (p.stage==="review_ready") {
      if (p.retirement_state!=="pending") return;
      const assignment=await telnyx.messaging10dlc.phoneNumberCampaigns.retrieve(p.phone_number,options);
      if (assignment.assignmentStatus!=="ASSIGNED" || assignment.phoneNumber!==p.phone_number || ![assignment.campaignId,assignment.telnyxCampaignId].includes(p.candidate_campaign_id!)) return;
      for await (const number of telnyx.messaging10dlc.phoneNumberCampaigns.list({},options)) {
        if ([number.campaignId,number.telnyxCampaignId].includes(p.source_campaign_id)) return;
      }
      try {
        await retireReviewUpgradeCampaign({upgradeId,claimToken:claim,campaignId:p.source_campaign_id});
        await record("retired");
      } catch {
        // Only an acquired destructive permit reaches 'submitting'. A denied
        // permit remains pending for re-evaluation without claiming a delete.
        if ((await readRow(upgradeId))?.retirement_state==="submitting") await record("retirement_unknown");
      }
    }
  } finally {
    await record("release_claim").catch(()=>{});
  }
}

async function recoverHandoffConsentConfirmations() {
  if (process.env.REVIEWS_SMS_SENDING_ENABLED!=="1") return;
  const events=await rpc<{business_id:string;provider_message_id:string;source_message_id:string|null;conversation_id:string|null;messaging_profile_id:string;sender:string;destination:string;occurred_at:string}[]>("review_texting_claim_confirmations",{p_limit:20});
  for (const e of events ?? []) {
    if (!e.source_message_id || !e.conversation_id || !isReviewSmsEnabled(e.business_id)) continue;
    await processReviewTextConsent({businessId:e.business_id,messagingProfileId:e.messaging_profile_id,from:e.destination,to:e.sender,text:"REVIEWS",conversationId:e.conversation_id,sourceMessageId:e.source_message_id,providerMessageId:e.provider_message_id,occurredAt:e.occurred_at});
  }
}
export async function runReviewTextingProviderLifecycle() {
  await recoverHandoffConsentConfirmations();
  const r=await db.from("review_texting_provider_upgrades").select("upgrade_id").or("stage.in.(prepared,submitting,carrier_pending,approved,moving),and(stage.eq.review_ready,retirement_state.eq.pending)").order("updated_at").limit(1);
  if (r.error) throw new Error("Review upgrade lifecycle unavailable");
  for (const p of r.data ?? []) await reconcileReviewTextingProvider(p.upgrade_id);
}
