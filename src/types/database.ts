export type BusinessType =
  | "plumber"
  | "dentist"
  | "restaurant"
  | "car_wash"
  | "salon"
  | "hvac"
  | "auto_shop"
  | "real_estate"
  | "legal"
  | "financial"
  | "insurance"
  | "retail"
  | "general"
  | "other";

export type KnowledgeSource = "scraped" | "manual" | "suggested";

export type FAQSource = KnowledgeSource;

export type AITone = "friendly" | "professional" | "balanced";

export type BusinessVoice = "we" | "business_name";

export type Language = "en" | "es" | "both";

export type BookingMode = "collect_info" | "schedule_direct";

export type PrimaryGoal = "book" | "signup" | "quote" | "callback";

export type Channel = "sms" | "web_chat" | "voice";

export type OperationalService = "ai_replies" | "texting" | "bookings";

export type OperationalBlockReason =
  | "account_suspended"
  | "ai_replies_paused"
  | "texting_paused"
  | "bookings_paused";

export interface BusinessOperationalControls {
  businessId: string;
  operationsSuspendedAt: string | null;
  aiRepliesPausedAt: string | null;
  textingPausedAt: string | null;
  bookingsPausedAt: string | null;
}

export type ConversationStatus = "active" | "closed" | "handed_off";

export type MessageRole = "customer" | "assistant" | "human_agent" | "system";

export type KnowledgeGapStatus = "open" | "resolved" | "dismissed";

/**
 * Every plan identifier the application and database may persist or read.
 * Sales visibility and channel-specific acquisition gates live separately;
 * recognizing a value here must never make it purchasable by itself.
 */
export const SUBSCRIPTION_PLAN_IDS = [
  "chat_only",
  "sms_only",
  "sms_and_chat",
  "full",
] as const;

export type SubscriptionPlan = (typeof SUBSCRIPTION_PLAN_IDS)[number];

export type SubscriptionStatus =
  | "active"
  | "past_due"
  | "canceled"
  | "trialing";

export type PartnerStatus = "active" | "inactive";

export type PartnerDomainStatus = "pending" | "connected";

export type PartnerEmailStatus = "unconfigured" | "pending" | "verified";

export type BillingMode = "stripe" | "invoiced" | "comped";

export type PartnerBillingMode = Exclude<BillingMode, "stripe">;

export type PartnerClientProvisioningStatus =
  | "pending"
  | "admin_setup"
  | "auth_created"
  | "business_prepared"
  | "assigned"
  | "invite_pending"
  | "setup_email_sent"
  | "needs_attention"
  | "dismissed";

export type PartnerClientProvisioningOperationKind =
  | "provision"
  | "retry"
  | "send_setup";

export type AdminActionEventAction =
  | "account_deletion_scheduled"
  | "account_operations_suspended"
  | "account_operations_reactivated"
  | "account_service_paused"
  | "account_service_resumed"
  | "phone_assignment_recheck_requested"
  | "provisioning_job_dismissed"
  | "provisioning_job_restored";

export type GoogleCalendarOAuthAttemptStatus =
  | "initiated"
  | "handoff_ready"
  | "claimed"
  | "failed";

export type GoogleCalendarOAuthSanitizedResult =
  | "access_denied"
  | "provider_error";

export type WidgetPosition = "bottom_right" | "bottom_left";

export type LeadCaptureTiming = "start" | "after_3_messages" | "on_booking";

export type BusinessEntityType =
  | "llc"
  | "c_corp"
  | "s_corp"
  | "nonprofit"
  | "partnership"
  | "sole_proprietor";

export type TaxIdType = "ein" | "ssn_last_4";

export type A2pBrandTier = "low_volume_standard" | "sole_proprietor";

export type NoEinHoldStatus =
  | "none"
  | "ein_encouraged"
  | "waitlisted"
  | "converted_to_ein";

export type RegistrationStatus = "pending" | "approved" | "rejected";

export type TelnyxBrandSource =
  | "created_by_simplassist"
  | "linked_existing";

export type OnboardingStep =
  | "business_info"
  | "business_hours"
  | "services_faqs"
  | "plan_selection"
  | "ai_settings"
  | "legal_verification"
  | "sms_use_case"
  | "phone_number"
  | "review_submit"
  | "carrier_review"
  | "complete";

export type OnboardingRegistrationStatus =
  | "not_started"
  | "submitting"
  | "failed"
  | "submitted";

export type A2pRiskReviewStatus =
  | "not_started"
  | "pending_review"
  | "blocked"
  | "passed"
  | "admin_approved";

export type A2pRiskChecklistAnswer = "none" | "restricted" | "not_sure";

export type CampaignAssignmentStatus =
  | "unassigned"
  | "pending"
  | "assigned"
  | "failed";

export type SmsBlockReason =
  | "campaign_not_approved"
  | "assignment_pending"
  | "assignment_failed"
  | "missing_messaging_profile"
  | "missing_phone_number";

export type BillingLaunchBlockReason =
  | "not_paid"
  | "past_due"
  | "canceled"
  | "telnyx_submission_disabled"
  | "usage_limit_reached"
  | "held_no_ein";

export type RegistrationHoldReason = "held_no_ein";

export type CallForwardingAttemptStatus =
  | "dialing"
  | "connected"
  | "abandoned"
  | "fallback_triggered"
  | "ended"
  | "error";

// Matches the CHECK constraint on businesses.privacy_terms_mode in
// supabase/migrations/015_business_slug_and_compliance_mode.sql. Phase 6.
export type PrivacyTermsMode = "hosted" | "self_hosted" | "existing";

// DB column telnyx_registration_events.event_type is intentionally unconstrained
// text so Phase 4/11 can add new event types without a migration. App code
// should write through TELNYX_EVENT_TYPES to keep audit logs typo-free.
export const TELNYX_EVENT_TYPES = [
  "brand_submitted",
  "brand_status_changed",
  "campaign_submitted",
  "campaign_status_changed",
  "campaign_status_refreshed",
  "messaging_profile_created",
  "messaging_profile_create_intent",
  "voice_application_created",
  "voice_application_create_intent",
  "phone_number_order_create_intent",
  "campaign_preflight_checked",
  "phone_number_assignment_started",
  "phone_number_assignment_status_changed",
  "phone_number_assignment_failed",
] as const;
export type TelnyxEventType = (typeof TELNYX_EVENT_TYPES)[number];

export type TelnyxResourceType =
  | "brand"
  | "campaign"
  | "messaging_profile"
  | "voice_application"
  | "phone_number"
  | "phone_number_assignment";

export interface Partner {
  id: string;
  name: string;
  slug: string;
  custom_domain: string | null;
  domain_status: PartnerDomainStatus;
  logo_light_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  brand_primary: string;
  brand_primary_hover: string;
  brand_primary_active: string;
  brand_accent: string;
  brand_primary_dark: string;
  brand_primary_hover_dark: string;
  brand_primary_active_dark: string;
  brand_accent_dark: string;
  email_from: string | null;
  email_from_status: PartnerEmailStatus;
  email_from_verified_at: string | null;
  email_from_verified_by: string | null;
  status: PartnerStatus;
  created_at: string;
  updated_at: string;
}

export interface PartnerClientProvisioningJob {
  id: string;
  email: string;
  requested_business_name: string;
  partner_id: string;
  billing_mode: PartnerBillingMode;
  partner_plan: SubscriptionPlan;
  auth_user_id: string | null;
  business_id: string | null;
  status: PartnerClientProvisioningStatus;
  last_error_code: string | null;
  setup_email_sent_at: string | null;
  invite_attempt_count: number;
  dismissed_at: string | null;
  dismissed_by_admin_id: string | null;
  operation_token: string | null;
  operation_kind: PartnerClientProvisioningOperationKind | null;
  operation_started_at: string | null;
  operation_expires_at: string | null;
  created_by_admin_id: string;
  created_at: string;
  updated_at: string;
}

export interface AdminActionEvent {
  id: string;
  actor_admin_user_id: string;
  action: AdminActionEventAction;
  business_id: string | null;
  provisioning_job_id: string | null;
  deletion_scheduled_for: string | null;
  summary: Record<string, unknown>;
  created_at: string;
}

export interface GoogleCalendarOAuthAttempt {
  id: string;
  state_digest: string;
  origin_verifier_digest: string;
  handoff_digest: string | null;
  business_id: string;
  owner_user_id: string;
  origin_partner_id: string | null;
  origin_hostname: string;
  status: GoogleCalendarOAuthAttemptStatus;
  authorization_code: string | null;
  sanitized_result: GoogleCalendarOAuthSanitizedResult | null;
  expires_at: string;
  handoff_expires_at: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Business {
  id: string;
  owner_id: string;
  name: string;
  business_type: BusinessType;
  business_type_other: string | null;
  primary_goal: PrimaryGoal | null;
  goal_url: string | null;
  website_url: string | null;
  phone_number: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  timezone: string;
  sms_consent_agreed: boolean;
  sms_consent_agreed_at: string | null;
  legal_business_name: string | null;
  business_entity_type: BusinessEntityType | null;
  business_registration_state: string | null;
  tax_id_type: TaxIdType | null;
  has_ein: boolean | null;
  a2p_brand_tier: A2pBrandTier | null;
  no_ein_hold_status: NoEinHoldStatus;
  no_ein_waitlist_requested_at: string | null;
  ein: string | null;
  last_4_ssn: string | null;
  registrant_mobile: string | null;
  authorized_rep_name: string | null;
  authorized_rep_title: string | null;
  authorized_rep_email: string | null;
  authorized_rep_phone: string | null;
  use_case_description: string | null;
  sample_messages: string[] | null;
  estimated_monthly_volume: string | null;
  opt_in_description: string | null;
  compliance_info_completed_at: string | null;
  pending_phone_number: string | null;
  pending_phone_number_area_code: string | null;
  pending_phone_number_selected_at: string | null;
  pending_phone_number_failure_reason: string | null;
  call_forwarding_enabled: boolean;
  forward_to_number: string | null;
  call_forwarding_nudge_resolved_at: string | null;
  operations_suspended_at: string | null;
  ai_replies_paused_at: string | null;
  texting_paused_at: string | null;
  bookings_paused_at: string | null;
  partner_id: string | null;
  billing_mode: BillingMode;
  partner_plan: SubscriptionPlan | null;
  billing_pilot: boolean;
  billing_comped: boolean;
  billing_exempt: boolean;
  telnyx_submission_disabled: boolean;
  sms_overage_opt_in: boolean;
  sms_overage_opted_in_at: string | null;
  sms_overage_opted_in_by: string | null;
  billing_admin_notes: string | null;
  billing_flags_updated_at: string | null;
  billing_flags_updated_by: string | null;
  onboarding_selected_plan: SubscriptionPlan | null;
  onboarding_step: OnboardingStep;
  onboarding_completed_at: string | null;
  onboarding_last_saved_at: string | null;
  onboarding_registration_status: OnboardingRegistrationStatus;
  onboarding_registration_started_at: string | null;
  onboarding_registration_submitted_at: string | null;
  onboarding_registration_error: string | null;
  a2p_risk_review_status: A2pRiskReviewStatus | null;
  a2p_risk_review_input_hash: string | null;
  a2p_risk_review_message: string | null;
  a2p_risk_review_reason: string | null;
  a2p_risk_review_findings: A2pRiskFinding[] | null;
  a2p_risk_review_customer_answer: A2pRiskChecklistAnswer | null;
  a2p_risk_review_customer_selections: string[] | null;
  a2p_risk_review_scanned_at: string | null;
  a2p_risk_review_notified_at: string | null;
  a2p_risk_review_reviewed_at: string | null;
  a2p_risk_review_reviewed_by: string | null;
  a2p_risk_review_override_note: string | null;
  a2p_risk_review_updated_at: string | null;
  slug: string;
  privacy_terms_mode: PrivacyTermsMode;
  privacy_url_override: string | null;
  terms_url_override: string | null;
  telnyx_brand_id: string | null;
  telnyx_brand_source: TelnyxBrandSource | null;
  telnyx_campaign_id: string | null;
  telnyx_messaging_profile_id: string | null;
  telnyx_voice_application_id: string | null;
  brand_status: RegistrationStatus | null;
  brand_status_updated_at: string | null;
  brand_rejection_reason: string | null;
  campaign_status: RegistrationStatus | null;
  campaign_status_updated_at: string | null;
  campaign_rejection_reason: string | null;
  telnyx_campaign_assignment_claim_token: string | null;
  telnyx_campaign_assignment_claimed_at: string | null;
  telnyx_campaign_assignment_claim_campaign_id: string | null;
  telnyx_campaign_assignment_claim_profile_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallForwardingAttempt {
  id: string;
  business_id: string;
  inbound_call_control_id: string;
  outbound_call_control_id: string | null;
  inbound_call_leg_id: string | null;
  outbound_call_leg_id: string | null;
  call_session_id: string;
  caller_phone: string;
  forward_to_number: string;
  status: CallForwardingAttemptStatus;
  fallback_triggered_at: string | null;
  abandoned_at: string | null;
  connected_at: string | null;
  ended_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface TelnyxRegistrationEvent {
  id: string;
  business_id: string;
  // Widened to string because the DB column is unconstrained; future phases
  // (Phase 4 webhook, Phase 11 OTP) will append types to TELNYX_EVENT_TYPES.
  event_type: string;
  telnyx_resource_type: TelnyxResourceType | null;
  telnyx_resource_id: string | null;
  status: string | null;
  rejection_reason: string | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string;
}

export interface A2pRiskFinding {
  ruleId: string;
  category: string;
  severity: "block" | "review";
  label: string;
  evidence: string[];
  source: string;
}

export interface A2pRiskReviewEvent {
  id: string;
  business_id: string;
  event_type: string;
  status: A2pRiskReviewStatus | null;
  input_hash: string | null;
  message: string | null;
  findings: A2pRiskFinding[] | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string;
}

export interface BusinessHours {
  id: string;
  business_id: string;
  day_of_week: number;
  open_time: string;
  close_time: string;
  is_closed: boolean;
}

export interface Service {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  price: string | null;
  source: KnowledgeSource;
  is_active: boolean;
}

export interface FAQ {
  id: string;
  business_id: string;
  question: string;
  answer: string;
  source: FAQSource;
  is_active: boolean;
}

export type BusinessKnowledgeKind = "overview" | "fact" | "policy";

export type BusinessKnowledgeSource =
  | "manual"
  | "website_scan"
  | "owner_answer";

/**
 * Owner-approved assistant context that does not fit the existing structured
 * service or FAQ tables. Website-scan drafts never use this type until the
 * owner publishes them.
 */
export interface BusinessKnowledgeItem {
  id: string;
  business_id: string;
  kind: BusinessKnowledgeKind;
  category: string | null;
  title: string | null;
  content: string;
  source: BusinessKnowledgeSource;
  is_active: boolean;
  sort_order: number;
  verified_at: string;
  created_at: string;
  updated_at: string;
}

export interface AISettings {
  id: string;
  business_id: string;
  tone: AITone;
  business_voice: BusinessVoice;
  language: Language;
  sms_response_delay_seconds: number;
  guardrails: string[];
  booking_enabled: boolean;
  booking_mode: BookingMode;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  business_id: string;
  name: string | null;
  phone_number: string | null;
  email: string | null;
  session_id: string | null;
  source_channel: Channel;
  lead_score: number;
  lead_status: "normal" | "warm" | "hot";
  lead_status_updated_at: string;
  notes: string | null;
  created_at: string;
  last_contacted_at: string;
}

export interface Conversation {
  id: string;
  business_id: string;
  contact_id: string;
  channel: Channel;
  status: ConversationStatus;
  is_ai_handling: boolean;
  started_at: string;
  last_message_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  business_id: string;
  provider_event_id: string | null;
  ai_reply_reservation_id: string | null;
  ai_reply_reservation_attempt_token: string | null;
  role: MessageRole;
  content: string;
  channel: Channel;
  created_at: string;
}

export interface KnowledgeGap {
  id: string;
  business_id: string;
  question_text: string;
  normalized_question: string;
  ai_response_text: string;
  channel: Channel;
  conversation_id: string | null;
  source_message_id: string | null;
  occurrence_count: number;
  status: KnowledgeGapStatus;
  resolved_faq_id: string | null;
  created_at: string;
  last_seen_at: string;
  updated_at: string;
}

export interface PhoneNumber {
  id: string;
  business_id: string;
  phone_number: string;
  telnyx_phone_number_id: string | null;
  telnyx_number_order_id: string | null;
  telnyx_number_order_phone_number_id: string | null;
  telnyx_campaign_assignment_status: CampaignAssignmentStatus;
  telnyx_campaign_assignment_task_id: string | null;
  telnyx_campaign_assignment_campaign_id: string | null;
  telnyx_campaign_assignment_failure_reason: string | null;
  telnyx_campaign_assignment_updated_at: string | null;
  telnyx_campaign_assigned_at: string | null;
  is_active: boolean;
  created_at: string;
}

export interface Subscription {
  id: string;
  business_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  current_period_start: string;
  current_period_end: string;
  stripe_price_id: string | null;
  stripe_setup_fee_price_id: string | null;
  stripe_checkout_session_id: string | null;
  setup_fee_paid_at: string | null;
  cancel_at_period_end: boolean;
  pending_plan: SubscriptionPlan | null;
  created_at: string;
  updated_at: string;
}

/**
 * Server-side representation of a Full Suite waitlist row.
 *
 * The launch claim fields are private delivery-coordination state. Public
 * waitlist endpoints must never serialize this interface (or any subset that
 * includes identifiers, email, unsubscribe state, or claim state).
 */
export interface WaitlistSignup {
  id: string;
  email: string;
  feature_interest: string | null;
  created_at: string;
  notified_at: string | null;
  unsubscribed_at: string | null;
  launch_send_claim_token: string | null;
  launch_send_claimed_at: string | null;
}

export type AccountDeletionStripeAction = "pause" | "resume" | "cancel";

export type AccountDeletionStripeActionStatus =
  | "pending"
  | "applied"
  | "blocked";

export interface AccountDeletionStripeActionRecord {
  business_id: string;
  stripe_subscription_id: string;
  desired_action: AccountDeletionStripeAction;
  applied_action: AccountDeletionStripeAction | null;
  status: AccountDeletionStripeActionStatus;
  generation: number;
  idempotency_key: string;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  last_attempted_at: string | null;
  applied_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingUsagePeriod {
  id: string;
  business_id: string;
  period_start: string;
  period_end: string;
  plan: SubscriptionPlan;
  included_sms_parts: number;
  inbound_sms_parts: number;
  outbound_sms_parts: number;
  inbound_mms_events: number;
  outbound_mms_events: number;
  ai_input_tokens: number;
  ai_output_tokens: number;
  warning_80_sent_at: string | null;
  hard_limit_reached_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingUsageEvent {
  id: string;
  business_id: string;
  usage_period_id: string;
  idempotency_key: string;
  direction: "inbound" | "outbound";
  channel: "sms" | "mms";
  source: string;
  sms_parts: number;
  mms_events: number;
  provider_message_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export type AIReplyReservationStatus =
  | "reserved"
  | "completed"
  | "released"
  | "expired";

export interface AIReplyUsagePeriod {
  id: string;
  business_id: string;
  period_start: string;
  period_end: string;
  billing_source: "subscription" | "partner_billing" | "billing_override";
  plan: SubscriptionPlan;
  /** NULL preserves the established uncapped behavior of existing plans. */
  included_ai_replies: number | null;
  completed_replies: number;
  created_at: string;
  updated_at: string;
}

export interface AIReplyReservation {
  id: string;
  business_id: string;
  usage_period_id: string;
  channel: "web_chat";
  client_message_id: string;
  request_fingerprint: string;
  source_message_id: string;
  status: AIReplyReservationStatus;
  attempt_token: string;
  attempt_count: number;
  reserved_at: string;
  expires_at: string;
  completed_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  assistant_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AIReplyReservationAttempt {
  reservation_id: string;
  attempt_count: number;
  attempt_token: string;
  status: AIReplyReservationStatus;
  reserved_at: string;
  expires_at: string;
  ended_at: string | null;
  created_at: string;
}

export interface AnthropicProviderCall {
  id: string;
  business_id: string;
  reservation_id: string | null;
  reservation_attempt_count: number | null;
  call_idempotency_key: string;
  operation: string;
  channel: Channel | null;
  is_preview: boolean;
  model: string;
  provider_request_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  latency_ms: number;
  stop_reason: string | null;
  tool_use_count: number;
  tool_result_count: number;
  succeeded: boolean;
  error_code: string | null;
  created_at: string;
}

export type ChatOnlyCheckoutAttemptState =
  | "creating"
  | "open"
  | "completed"
  | "expired";

/** Private service-role state for one-payable-Checkout single-flight. */
export interface ChatOnlyCheckoutAttempt {
  id: string;
  business_id: string;
  plan: "chat_only";
  checkout_mode: "onboarding";
  stripe_price_id: string;
  request_fingerprint: string;
  state: ChatOnlyCheckoutAttemptState;
  claim_token: string;
  claimed_at: string;
  claim_expires_at: string;
  attempt_count: number;
  stripe_checkout_session_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  /** Sensitive bearer-like provider URL; never expose to a customer role. */
  checkout_url: string | null;
  checkout_session_expires_at: string;
  completed_at: string | null;
  expired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoogleCalendarToken {
  id: string;
  business_id: string;
  access_token: string;
  refresh_token: string;
  token_expiry: string;
  calendar_id: string;
  google_email: string | null;
  credential_version: string;
  created_at: string;
  updated_at: string;
}

export type CalendarProviderOperationKind = "create" | "update" | "delete";

export type CalendarProviderOperationStatus =
  | "holding"
  | "provider_applied"
  | "finalized"
  | "failed";

/** Private service-role state for idempotent dashboard calendar mutations. */
export interface CalendarProviderOperationRecord {
  id: string;
  business_id: string;
  operation_kind: CalendarProviderOperationKind;
  google_calendar_id: string;
  desired_starts_at: string | null;
  desired_ends_at: string | null;
  linked_booking_id: string | null;
  deterministic_google_event_id: string | null;
  target_google_event_id: string | null;
  provider_target_event_id: string | null;
  request_fingerprint: string;
  status: CalendarProviderOperationStatus;
  claim_token: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  claim_released_at: string | null;
  reconciliation_review_after_at: string;
  attempt_count: number;
  provider_submission_started_at: string | null;
  provider_event_id: string | null;
  provider_starts_at: string | null;
  provider_ends_at: string | null;
  provider_evidence: Record<string, unknown> | null;
  provider_applied_at: string | null;
  finalized_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  reconciliation_claim_token: string | null;
  reconciliation_claimed_at: string | null;
  reconciliation_claim_expires_at: string | null;
  reconciliation_attempt_count: number;
  reconciliation_attempted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WidgetConfig {
  id: string;
  business_id: string;
  brand_color: string;
  position: WidgetPosition;
  welcome_message: string;
  proactive_invitation_enabled: boolean;
  show_logo: boolean;
  logo_url: string | null;
  lead_capture_enabled: boolean;
  lead_capture_timing: LeadCaptureTiming;
  quick_replies: string[];
  allowed_hostnames: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
